import mysqlPromise from 'mysql2/promise';
import * as mysql_utils from '../utils/mysql-utils.js';
import { ColumnDescriptor } from '@powersync/service-core';
import { TablePattern } from '@powersync/service-sync-rules';

export interface GetColumnsOptions {
  connection: mysqlPromise.Connection;
  schema: string;
  tableName: string;
}

export async function getColumns(options: GetColumnsOptions): Promise<ColumnDescriptor[]> {
  const { connection, schema, tableName } = options;

  const [allColumns] = await mysql_utils.retriedQuery({
    connection: connection,
    query: `
      SELECT 
        s.COLUMN_NAME AS name,
        c.DATA_TYPE as type
      FROM 
        INFORMATION_SCHEMA.COLUMNS s
        JOIN 
          INFORMATION_SCHEMA.COLUMNS c
            ON 
              s.TABLE_SCHEMA = c.TABLE_SCHEMA
              AND s.TABLE_NAME = c.TABLE_NAME
              AND s.COLUMN_NAME = c.COLUMN_NAME
      WHERE 
        s.TABLE_SCHEMA = ?
        AND s.TABLE_NAME = ?
      ORDER BY 
        s.ORDINAL_POSITION;
      `,
    params: [schema, tableName]
  });

  return allColumns.map((row) => {
    return {
      name: row.name,
      type: row.type
    };
  });
}

export interface GetReplicationIdentityColumnsOptions {
  connection: mysqlPromise.Connection;
  schema: string;
  tableName: string;
}

export interface ReplicationIdentityColumnsResult {
  columns: ColumnDescriptor[];
  //   TODO maybe export an enum from the core package
  identity: string;
}

export async function getReplicationIdentityColumns(
  options: GetReplicationIdentityColumnsOptions
): Promise<ReplicationIdentityColumnsResult> {
  const { connection, schema, tableName } = options;
  const [primaryKeyColumns] = await mysql_utils.retriedQuery({
    connection: connection,
    query: `
      SELECT 
        s.COLUMN_NAME AS name,
        c.DATA_TYPE AS type
      FROM 
        INFORMATION_SCHEMA.STATISTICS s
        JOIN 
          INFORMATION_SCHEMA.COLUMNS c 
            ON 
              s.TABLE_SCHEMA = c.TABLE_SCHEMA
              AND s.TABLE_NAME = c.TABLE_NAME
              AND s.COLUMN_NAME = c.COLUMN_NAME
      WHERE 
        s.TABLE_SCHEMA = ?
        AND s.TABLE_NAME = ?
        AND s.INDEX_NAME = 'PRIMARY'
      ORDER BY 
        s.SEQ_IN_INDEX;
      `,
    params: [schema, tableName]
  });

  if (primaryKeyColumns.length) {
    return {
      columns: primaryKeyColumns.map((row) => ({
        name: row.name,
        type: row.type
      })),
      identity: 'default'
    };
  }

  // No primary key, check if any of the columns have a unique constraint we can use
  const [uniqueKeyColumns] = await mysql_utils.retriedQuery({
    connection: connection,
    query: `
      SELECT 
        s.INDEX_NAME,
        s.COLUMN_NAME,
        c.DATA_TYPE,
        s.NON_UNIQUE,
        s.NULLABLE
      FROM 
        INFORMATION_SCHEMA.STATISTICS s
      JOIN 
        INFORMATION_SCHEMA.COLUMNS c
          ON 
            s.TABLE_SCHEMA = c.TABLE_SCHEMA
            AND s.TABLE_NAME = c.TABLE_NAME
            AND s.COLUMN_NAME = c.COLUMN_NAME
      WHERE 
        s.TABLE_SCHEMA = ?
        AND s.TABLE_NAME = ?
        AND s.INDEX_NAME != 'PRIMARY'
        AND s.NON_UNIQUE = 0
      ORDER BY s.SEQ_IN_INDEX;
      `,
    params: [schema, tableName]
  });

  if (uniqueKeyColumns.length > 0) {
    return {
      columns: uniqueKeyColumns.map((col) => ({
        name: col.COLUMN_NAME,
        type: col.DATA_TYPE
      })),
      identity: 'index'
    };
  }

  const allColumns = await getColumns({
    connection: connection,
    schema: schema,
    tableName: tableName
  });

  return {
    columns: allColumns,
    identity: 'full'
  };
}

export async function getTablesFromPattern(
  connection: mysqlPromise.Connection,
  tablePattern: TablePattern
): Promise<string[]> {
  const schema = tablePattern.schema;

  if (tablePattern.isWildcard) {
    const [results] = await mysql_utils.retriedQuery({
      connection: connection,
      query: `
          SELECT TABLE_NAME
          FROM information_schema.tables
          WHERE TABLE_SCHEMA = ?
            AND TABLE_NAME LIKE ?
            AND table_type = 'BASE TABLE'
      `,
      params: [schema, tablePattern.tablePattern]
    });

    return results
      .map((row) => row.TABLE_NAME)
      .filter((tableName: string) => tableName.startsWith(tablePattern.tablePrefix));
  } else {
    const [results] = await mysql_utils.retriedQuery({
      connection: connection,
      query: `
          SELECT TABLE_NAME
          FROM information_schema.tables
          WHERE TABLE_SCHEMA = ?
            AND TABLE_NAME = ?
            AND table_type = 'BASE TABLE'
        `,
      params: [schema, tablePattern.tablePattern]
    });

    return results.map((row) => row.TABLE_NAME);
  }
}
