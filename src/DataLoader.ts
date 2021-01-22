/*
 * This file is a part of "NMIG" - the database migration tool.
 *
 * Copyright (C) 2016 - present, Anatoly Khaytovich <anatolyuss@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program (please see the "LICENSE.md" file).
 * If not, see <http://www.gnu.org/licenses/gpl.txt>.
 *
 * @author Anatoly Khaytovich <anatolyuss@gmail.com>
 */
import * as path from 'path';
import { Readable, ReadableOptions } from 'stream';
import { EventEmitter } from 'events';

import { PoolClient, QueryResult } from 'pg';
import { PoolConnection, Query } from 'mysql';
const { from } = require('pg-copy-streams'); // No declaration file for module "pg-copy-streams".
const { parse } = require('json2csv'); // No declaration file for module "json2csv".

import { log, generateError } from './FsOps';
import Conversion from './Conversion';
import DBAccess from './DBAccess';
import MessageToMaster from './MessageToMaster';
import MessageToDataLoader from './MessageToDataLoader';
import CsvParsingOptions from './CsvParsingOptions';
import { dataTransferred } from './ConsistencyEnforcer';
import * as extraConfigProcessor from './ExtraConfigProcessor';
import { getDataPoolTableName } from './DataPoolManager';

process.on('message', async (signal: MessageToDataLoader) => {
    const { config, chunk } = signal;
    const conv: Conversion = new Conversion(config);
    log(conv, `\t--[loadData] Loading the data into "${ conv._schema }"."${ chunk._tableName }" table...`);

    const isRecoveryMode: boolean = await dataTransferred(conv, chunk._id);

    if (!isRecoveryMode) {
        await populateTableWorker(conv, chunk._tableName, chunk._selectFieldList, chunk._rowsCnt, chunk._id);
        return;
    }

    const client: PoolClient = await DBAccess.getPgClient(conv);
    return deleteChunk(conv, chunk._id, client);
});

/**
 * Wraps "process.send" method to avoid "cannot invoke an object which is possibly undefined" warning.
 */
const processSend = (x: any): void => {
    if (process.send) {
        process.send(x);
    }
};

/**
 * Deletes given record from the data-pool.
 */
const deleteChunk = async (
    conversion: Conversion,
    dataPoolId: number,
    client: PoolClient,
    originalSessionReplicationRole: string | null = null
): Promise<void> => {
    const sql: string = `DELETE FROM ${ getDataPoolTableName(conversion) } WHERE id = ${ dataPoolId };`;

    try {
        await client.query(sql);

        if (originalSessionReplicationRole) {
            await enableTriggers(conversion, client, <string>originalSessionReplicationRole);
        }
    } catch (error) {
        await generateError(conversion, `\t--[DataLoader::deleteChunk] ${ error }`, sql);
    } finally {
        await DBAccess.releaseDbClient(conversion, client);
    }
};

/**
 * Processes data-loading error.
 */
const processDataError = async (
    conv: Conversion,
    streamError: string,
    sql: string,
    sqlCopy: string,
    tableName: string,
    dataPoolId: number,
    client: PoolClient,
    originalSessionReplicationRole: string | null
): Promise<void> => {
    await generateError(conv, `\t--[populateTableWorker] ${ streamError }`, sqlCopy);
    const rejectedData: string = `\t--[populateTableWorker] Error loading table data:\n${ sql }\n`;
    log(conv, rejectedData, path.join(conv._logsDirPath, `${ tableName }.log`));
    await deleteChunk(conv, dataPoolId, client, originalSessionReplicationRole);
    processSend(new MessageToMaster(tableName, 0));
};

/**
 * Loads a chunk of data using "PostgreSQL COPY".
 */
const populateTableWorker = async (
    conversion: Conversion,
    tableName: string,
    strSelectFieldList: string,
    rowsCnt: number,
    dataPoolId: number
): Promise<void> => {
    const originalTableName: string = extraConfigProcessor.getTableName(conversion, tableName, true);
    const sqlRetrieve: string = `SELECT ${ strSelectFieldList } FROM \`${ originalTableName }\`;`;
    const mysqlClient: PoolConnection = await DBAccess.getMysqlClient(conversion);
    const pgTableName: string = `"${ conversion._schema }"."${ tableName }"`;
    const sqlCopy: string = `COPY ${ pgTableName } FROM STDIN DELIMITER '${ conversion._delimiter }' CSV;`;
    const client: PoolClient = await DBAccess.getPgClient(conversion);
    let originalSessionReplicationRole: string | null = null;

    if (conversion.shouldMigrateOnlyData()) {
        originalSessionReplicationRole = await disableTriggers(conversion, client);
    }

    const eventEmitter: EventEmitter = new EventEmitter();
    const query: Query = mysqlClient.query(sqlRetrieve);
    let dataBuffer: string[] = [];

    query
        .on('error', async (errorSqlRetrieve: string) => {
            await processDataError(
                conversion,
                errorSqlRetrieve,
                sqlRetrieve,
                sqlCopy,
                tableName,
                dataPoolId,
                client,
                originalSessionReplicationRole
            );
        })
        .on('result', async (row: any) => {
            // TODO: consider to toss try-catch blocks, and avoid async callback!!!
            try {
                // !!!Notice, initializing Parser with options once,
                // within on('fields'), produces corrupted csv somehow.
                // TODO: check CsvParsingOptions.
                const csv: string = parse(row, {
                    delimiter: conversion._delimiter,
                    header: false,
                    fields: Object.keys(row),
                });

                dataBuffer.push(csv);

                if (dataBuffer.length >= conversion._streamsHighWaterMark) {
                    eventEmitter.emit('chunkBuffered');
                    mysqlClient.pause();
                }
            } catch (csvParsingError) {
                await processDataError(
                    conversion,
                    csvParsingError,
                    '',
                    '',
                    originalTableName,
                    dataPoolId,
                    client,
                    originalSessionReplicationRole
                );
            }
        })
        .on('end', () => {
            // Current connection should not be released, because it will not be reused.
            // This is due the "DataLoader" process termination.
            // Hence, the connection should be "destroyed".
            mysqlClient.destroy();
        });

    eventEmitter.on('chunkLoaded', () => {
        mysqlClient.resume();
    });

    eventEmitter.on('chunkBuffered', () => {
        const copyStream = getCopyStream(
            conversion,
            client,
            sqlCopy,
            sqlRetrieve,
            tableName,
            rowsCnt,
            dataPoolId,
            originalSessionReplicationRole,
            dataBuffer,
            eventEmitter
        );

        const readableOptions: ReadableOptions = {
            objectMode: true,
            highWaterMark: conversion._streamsHighWaterMark,
        };

        const dataStream: Readable = Readable.from(dataBuffer, readableOptions);

        dataStream
            .on('error', (error: Error) => {
                console.log();
                console.error(error);
            })
            .on('end', () => dataStream.destroy())
            .pipe(copyStream);
    });
};

/**
 * Returns new PostgreSQL copy stream object.
 */
const getCopyStream = (
    conv: Conversion,
    client: PoolClient,
    sqlCopy: string,
    sql: string,
    tableName: string,
    rowsCnt: number,
    dataPoolId: number,
    originalSessionReplicationRole: string | null,
    dataBuffer: string[],
    eventEmitter: EventEmitter
) => {
    const copyStream: any = client.query(from(sqlCopy));

    copyStream
        .on('finish', async () => {
            // COPY FROM STDIN does not return the number of rows inserted.
            // But the transactional behavior still applies, meaning no records inserted if at least one failed.
            // That is why in case of 'on finish' the rowsCnt value is actually the number of records inserted.

            // TODO: continue.
            dataBuffer = [];
            eventEmitter.emit('chunkLoaded');
            copyStream.destroy();

            // processSend(new MessageToMaster(tableName, rowsCnt));
            // await deleteChunk(conv, dataPoolId, client);
        })
        .on('error', async (copyStreamError: string) => {
            await processDataError(conv, copyStreamError, sql, sqlCopy, tableName, dataPoolId, client, originalSessionReplicationRole);
        });

    return copyStream;
};

/**
 * Disables all triggers and rules for current database session.
 * !!!DO NOT release the client, it will be released after current data-chunk deletion.
 */
const disableTriggers = async (conversion: Conversion, client: PoolClient): Promise<string> => {
    let sql: string = `SHOW session_replication_role;`;
    let originalSessionReplicationRole: string = 'origin';

    try {
        const queryResult: QueryResult = await client.query(sql);
        originalSessionReplicationRole = queryResult.rows[0].session_replication_role;
        sql = 'SET session_replication_role = replica;';
        await client.query(sql);
    } catch (error) {
        await generateError(conversion, `\t--[DataLoader::disableTriggers] ${ error }`, sql);
    }

    return originalSessionReplicationRole;
};

/**
 * Enables all triggers and rules for current database session.
 * !!!DO NOT release the client, it will be released after current data-chunk deletion.
 */
const enableTriggers = async (
    conversion: Conversion,
    client: PoolClient,
    originalSessionReplicationRole: string
): Promise<void> => {
    const sql: string = `SET session_replication_role = ${ originalSessionReplicationRole };`;

    try {
        await client.query(sql);
    } catch (error) {
        await generateError(conversion, `\t--[DataLoader::enableTriggers] ${ error }`, sql);
    }
};
