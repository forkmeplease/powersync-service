import * as lib_postgres from '@powersync/lib-service-postgres';
import {
  BroadcastIterable,
  CHECKPOINT_INVALIDATE_ALL,
  CheckpointChanges,
  GetCheckpointChangesOptions,
  InternalOpId,
  internalToExternalOpId,
  LastValueSink,
  maxLsn,
  storage,
  utils,
  WatchWriteCheckpointOptions
} from '@powersync/service-core';
import { JSONBig } from '@powersync/service-jsonbig';
import * as sync_rules from '@powersync/service-sync-rules';
import * as timers from 'timers/promises';
import * as uuid from 'uuid';
import { BIGINT_MAX } from '../types/codecs.js';
import { models, RequiredOperationBatchLimits } from '../types/types.js';
import { replicaIdToSubkey } from '../utils/bson.js';
import { mapOpEntry } from '../utils/bucket-data.js';

import * as framework from '@powersync/lib-services-framework';
import { StatementParam } from '@powersync/service-jpgwire';
import { wrapWithAbort } from 'ix/asynciterable/operators/withabort.js';
import { SourceTableDecoded, StoredRelationId } from '../types/models/SourceTable.js';
import { pick } from '../utils/ts-codec.js';
import { PostgresBucketBatch } from './batch/PostgresBucketBatch.js';
import { PostgresWriteCheckpointAPI } from './checkpoints/PostgresWriteCheckpointAPI.js';
import { PostgresBucketStorageFactory } from './PostgresBucketStorageFactory.js';
import { PostgresCompactor } from './PostgresCompactor.js';

export type PostgresSyncRulesStorageOptions = {
  factory: PostgresBucketStorageFactory;
  db: lib_postgres.DatabaseClient;
  sync_rules: storage.PersistedSyncRulesContent;
  write_checkpoint_mode?: storage.WriteCheckpointMode;
  batchLimits: RequiredOperationBatchLimits;
};

export class PostgresSyncRulesStorage
  extends framework.BaseObserver<storage.SyncRulesBucketStorageListener>
  implements storage.SyncRulesBucketStorage
{
  public readonly group_id: number;
  public readonly sync_rules: storage.PersistedSyncRulesContent;
  public readonly slot_name: string;
  public readonly factory: PostgresBucketStorageFactory;

  private sharedIterator = new BroadcastIterable((signal) => this.watchActiveCheckpoint(signal));

  protected db: lib_postgres.DatabaseClient;
  protected writeCheckpointAPI: PostgresWriteCheckpointAPI;

  //   TODO we might be able to share this in an abstract class
  private parsedSyncRulesCache: { parsed: sync_rules.SqlSyncRules; options: storage.ParseSyncRulesOptions } | undefined;
  private checksumCache = new storage.ChecksumCache({
    fetchChecksums: (batch) => {
      return this.getChecksumsInternal(batch);
    }
  });

  constructor(protected options: PostgresSyncRulesStorageOptions) {
    super();
    this.group_id = options.sync_rules.id;
    this.db = options.db;
    this.sync_rules = options.sync_rules;
    this.slot_name = options.sync_rules.slot_name;
    this.factory = options.factory;

    this.writeCheckpointAPI = new PostgresWriteCheckpointAPI({
      db: this.db,
      mode: options.write_checkpoint_mode ?? storage.WriteCheckpointMode.MANAGED
    });
  }

  get writeCheckpointMode(): storage.WriteCheckpointMode {
    return this.writeCheckpointAPI.writeCheckpointMode;
  }

  //   TODO we might be able to share this in an abstract class
  getParsedSyncRules(options: storage.ParseSyncRulesOptions): sync_rules.SqlSyncRules {
    const { parsed, options: cachedOptions } = this.parsedSyncRulesCache ?? {};
    /**
     * Check if the cached sync rules, if present, had the same options.
     * Parse sync rules if the options are different or if there is no cached value.
     */
    if (!parsed || options.defaultSchema != cachedOptions?.defaultSchema) {
      this.parsedSyncRulesCache = { parsed: this.sync_rules.parsed(options).sync_rules, options };
    }

    return this.parsedSyncRulesCache!.parsed;
  }

  async reportError(e: any): Promise<void> {
    const message = String(e.message ?? 'Replication failure');
    await this.db.sql`
      UPDATE sync_rules
      SET
        last_fatal_error = ${{ type: 'varchar', value: message }}
      WHERE
        id = ${{ type: 'int4', value: this.group_id }};
    `.execute();
  }

  compact(options?: storage.CompactOptions): Promise<void> {
    return new PostgresCompactor(this.db, this.group_id, options).compact();
  }

  lastWriteCheckpoint(filters: storage.SyncStorageLastWriteCheckpointFilters): Promise<bigint | null> {
    return this.writeCheckpointAPI.lastWriteCheckpoint({
      ...filters,
      sync_rules_id: this.group_id
    });
  }

  setWriteCheckpointMode(mode: storage.WriteCheckpointMode): void {
    return this.writeCheckpointAPI.setWriteCheckpointMode(mode);
  }

  createManagedWriteCheckpoint(checkpoint: storage.ManagedWriteCheckpointOptions): Promise<bigint> {
    return this.writeCheckpointAPI.createManagedWriteCheckpoint(checkpoint);
  }

  async getCheckpoint(): Promise<storage.ReplicationCheckpoint> {
    const checkpointRow = await this.db.sql`
      SELECT
        last_checkpoint,
        last_checkpoint_lsn
      FROM
        sync_rules
      WHERE
        id = ${{ type: 'int4', value: this.group_id }}
    `
      .decoded(pick(models.SyncRules, ['last_checkpoint', 'last_checkpoint_lsn']))
      .first();

    return {
      checkpoint: checkpointRow?.last_checkpoint ?? 0n,
      lsn: checkpointRow?.last_checkpoint_lsn ?? null
    };
  }

  async resolveTable(options: storage.ResolveTableOptions): Promise<storage.ResolveTableResult> {
    const { group_id, connection_id, connection_tag, entity_descriptor } = options;

    const { schema, name: table, objectId, replicaIdColumns } = entity_descriptor;

    const normalizedReplicaIdColumns = replicaIdColumns.map((column) => ({
      name: column.name,
      type: column.type,
      // The PGWire returns this as a BigInt. We want to store this as JSONB
      type_oid: typeof column.typeId !== 'undefined' ? Number(column.typeId) : column.typeId
    }));
    return this.db.transaction(async (db) => {
      let sourceTableRow: SourceTableDecoded | null;
      if (objectId != null) {
        sourceTableRow = await db.sql`
          SELECT
            *
          FROM
            source_tables
          WHERE
            group_id = ${{ type: 'int4', value: group_id }}
            AND connection_id = ${{ type: 'int4', value: connection_id }}
            AND relation_id = ${{ type: 'jsonb', value: { object_id: objectId } satisfies StoredRelationId }}
            AND schema_name = ${{ type: 'varchar', value: schema }}
            AND table_name = ${{ type: 'varchar', value: table }}
            AND replica_id_columns = ${{ type: 'jsonb', value: normalizedReplicaIdColumns }}
        `
          .decoded(models.SourceTable)
          .first();
      } else {
        sourceTableRow = await db.sql`
          SELECT
            *
          FROM
            source_tables
          WHERE
            group_id = ${{ type: 'int4', value: group_id }}
            AND connection_id = ${{ type: 'int4', value: connection_id }}
            AND schema_name = ${{ type: 'varchar', value: schema }}
            AND table_name = ${{ type: 'varchar', value: table }}
            AND replica_id_columns = ${{ type: 'jsonb', value: normalizedReplicaIdColumns }}
        `
          .decoded(models.SourceTable)
          .first();
      }

      if (sourceTableRow == null) {
        const row = await db.sql`
          INSERT INTO
            source_tables (
              id,
              group_id,
              connection_id,
              relation_id,
              schema_name,
              table_name,
              replica_id_columns
            )
          VALUES
            (
              ${{ type: 'varchar', value: uuid.v4() }},
              ${{ type: 'int4', value: group_id }},
              ${{ type: 'int4', value: connection_id }},
              --- The objectId can be string | number | undefined, we store it as jsonb value
              ${{ type: 'jsonb', value: { object_id: objectId } satisfies StoredRelationId }},
              ${{ type: 'varchar', value: schema }},
              ${{ type: 'varchar', value: table }},
              ${{ type: 'jsonb', value: normalizedReplicaIdColumns }}
            )
          RETURNING
            *
        `
          .decoded(models.SourceTable)
          .first();
        sourceTableRow = row;
      }

      const sourceTable = new storage.SourceTable({
        id: sourceTableRow!.id,
        connectionTag: connection_tag,
        objectId: objectId,
        schema: schema,
        name: table,
        replicaIdColumns: replicaIdColumns,
        snapshotComplete: sourceTableRow!.snapshot_done ?? true
      });
      if (!sourceTable.snapshotComplete) {
        sourceTable.snapshotStatus = {
          totalEstimatedCount: Number(sourceTableRow!.snapshot_total_estimated_count ?? -1n),
          replicatedCount: Number(sourceTableRow!.snapshot_replicated_count ?? 0n),
          lastKey: sourceTableRow!.snapshot_last_key
        };
      }
      sourceTable.syncEvent = options.sync_rules.tableTriggersEvent(sourceTable);
      sourceTable.syncData = options.sync_rules.tableSyncsData(sourceTable);
      sourceTable.syncParameters = options.sync_rules.tableSyncsParameters(sourceTable);

      let truncatedTables: SourceTableDecoded[] = [];
      if (objectId != null) {
        // relation_id present - check for renamed tables
        truncatedTables = await db.sql`
          SELECT
            *
          FROM
            source_tables
          WHERE
            group_id = ${{ type: 'int4', value: group_id }}
            AND connection_id = ${{ type: 'int4', value: connection_id }}
            AND id != ${{ type: 'varchar', value: sourceTableRow!.id }}
            AND (
              relation_id = ${{ type: 'jsonb', value: { object_id: objectId } satisfies StoredRelationId }}
              OR (
                schema_name = ${{ type: 'varchar', value: schema }}
                AND table_name = ${{ type: 'varchar', value: table }}
              )
            )
        `
          .decoded(models.SourceTable)
          .rows();
      } else {
        // relation_id not present - only check for changed replica_id_columns
        truncatedTables = await db.sql`
          SELECT
            *
          FROM
            source_tables
          WHERE
            group_id = ${{ type: 'int4', value: group_id }}
            AND connection_id = ${{ type: 'int4', value: connection_id }}
            AND id != ${{ type: 'varchar', value: sourceTableRow!.id }}
            AND (
              schema_name = ${{ type: 'varchar', value: schema }}
              AND table_name = ${{ type: 'varchar', value: table }}
            )
        `
          .decoded(models.SourceTable)
          .rows();
      }

      return {
        table: sourceTable,
        dropTables: truncatedTables.map(
          (doc) =>
            new storage.SourceTable({
              id: doc.id,
              connectionTag: connection_tag,
              objectId: doc.relation_id?.object_id ?? 0,
              schema: doc.schema_name,
              name: doc.table_name,
              replicaIdColumns:
                doc.replica_id_columns?.map((c) => ({
                  name: c.name,
                  typeOid: c.typeId,
                  type: c.type
                })) ?? [],
              snapshotComplete: doc.snapshot_done ?? true
            })
        )
      };
    });
  }

  async startBatch(
    options: storage.StartBatchOptions,
    callback: (batch: storage.BucketStorageBatch) => Promise<void>
  ): Promise<storage.FlushedResult | null> {
    const syncRules = await this.db.sql`
      SELECT
        last_checkpoint_lsn,
        no_checkpoint_before,
        keepalive_op,
        snapshot_lsn
      FROM
        sync_rules
      WHERE
        id = ${{ type: 'int4', value: this.group_id }}
    `
      .decoded(pick(models.SyncRules, ['last_checkpoint_lsn', 'no_checkpoint_before', 'keepalive_op', 'snapshot_lsn']))
      .first();

    const checkpoint_lsn = syncRules?.last_checkpoint_lsn ?? null;

    const batch = new PostgresBucketBatch({
      logger: options.logger ?? framework.logger,
      db: this.db,
      sync_rules: this.sync_rules.parsed(options).sync_rules,
      group_id: this.group_id,
      slot_name: this.slot_name,
      last_checkpoint_lsn: checkpoint_lsn,
      keep_alive_op: syncRules?.keepalive_op,
      no_checkpoint_before_lsn: syncRules?.no_checkpoint_before ?? options.zeroLSN,
      resumeFromLsn: maxLsn(syncRules?.snapshot_lsn, checkpoint_lsn),
      store_current_data: options.storeCurrentData,
      skip_existing_rows: options.skipExistingRows ?? false,
      batch_limits: this.options.batchLimits,
      markRecordUnavailable: options.markRecordUnavailable
    });
    this.iterateListeners((cb) => cb.batchStarted?.(batch));

    await callback(batch);
    await batch.flush();
    if (batch.last_flushed_op != null) {
      return { flushed_op: batch.last_flushed_op };
    } else {
      return null;
    }
  }

  async getParameterSets(
    checkpoint: utils.InternalOpId,
    lookups: sync_rules.ParameterLookup[]
  ): Promise<sync_rules.SqliteJsonRow[]> {
    const rows = await this.db.sql`
      SELECT DISTINCT
        ON (lookup, source_table, source_key) lookup,
        source_table,
        source_key,
        id,
        bucket_parameters
      FROM
        bucket_parameters
      WHERE
        group_id = ${{ type: 'int4', value: this.group_id }}
        AND lookup = ANY (
          SELECT
            decode((FILTER ->> 0)::text, 'hex') -- Decode the hex string to bytea
          FROM
            jsonb_array_elements(${{
        type: 'jsonb',
        value: lookups.map((l) => storage.serializeLookupBuffer(l).toString('hex'))
      }}) AS FILTER
        )
        AND id <= ${{ type: 'int8', value: checkpoint }}
      ORDER BY
        lookup,
        source_table,
        source_key,
        id DESC
    `
      .decoded(pick(models.BucketParameters, ['bucket_parameters']))
      .rows();

    const groupedParameters = rows.map((row) => {
      return JSONBig.parse(row.bucket_parameters) as sync_rules.SqliteJsonRow;
    });
    return groupedParameters.flat();
  }

  async *getBucketDataBatch(
    checkpoint: InternalOpId,
    dataBuckets: Map<string, InternalOpId>,
    options?: storage.BucketDataBatchOptions
  ): AsyncIterable<storage.SyncBucketDataChunk> {
    if (dataBuckets.size == 0) {
      return;
    }

    // Internal naming:
    // We do a query for one "batch", which may be returend in multiple "chunks".
    // Each chunk is limited to single bucket, and is limited in length and size.
    // There are also overall batch length and size limits.
    // Each batch query batch are streamed in separate sets of rows, which may or may
    // not match up with chunks.

    const end = checkpoint ?? BIGINT_MAX;
    const filters = Array.from(dataBuckets.entries()).map(([name, start]) => ({
      bucket_name: name,
      start: start
    }));

    const batchRowLimit = options?.limit ?? storage.DEFAULT_DOCUMENT_BATCH_LIMIT;
    const chunkSizeLimitBytes = options?.chunkLimitBytes ?? storage.DEFAULT_DOCUMENT_CHUNK_LIMIT_BYTES;

    let chunkSizeBytes = 0;
    let currentChunk: utils.SyncBucketData | null = null;
    let targetOp: InternalOpId | null = null;
    let batchRowCount = 0;

    /**
     * It is possible to perform this query with JSONB join. e.g.
     * ```sql
     * WITH
     * filter_data AS (
     * SELECT
     * FILTER ->> 'bucket_name' AS bucket_name,
     * (FILTER ->> 'start')::BIGINT AS start_op_id
     * FROM
     * jsonb_array_elements($1::jsonb) AS FILTER
     * )
     * SELECT
     * b.*,
     * octet_length(b.data) AS data_size
     * FROM
     * bucket_data b
     * JOIN filter_data f ON b.bucket_name = f.bucket_name
     * AND b.op_id > f.start_op_id
     * AND b.op_id <= $2
     * WHERE
     * b.group_id = $3
     * ORDER BY
     * b.bucket_name ASC,
     * b.op_id ASC
     * LIMIT
     * $4;
     * ```
     * Which might be better for large volumes of buckets, but in testing the JSON method
     * was significantly slower than the method below. Syncing 2.5 million rows in a single
     * bucket takes 2 minutes and 11 seconds with the method below. With the JSON method
     * 1 million rows were only synced before a 5 minute timeout.
     */
    for await (const rows of this.db.streamRows({
      statement: `
          SELECT
            *
          FROM
            bucket_data 
          WHERE
            group_id = $1
            and op_id <= $2
            and (
            ${filters.map((f, index) => `(bucket_name = $${index * 2 + 4} and op_id > $${index * 2 + 5})`).join(' OR ')}
            ) 
          ORDER BY
            bucket_name ASC,
            op_id ASC
          LIMIT
            $3;`,
      params: [
        { type: 'int4', value: this.group_id },
        { type: 'int8', value: end },
        { type: 'int4', value: batchRowLimit },
        ...filters.flatMap((f) => [
          { type: 'varchar' as const, value: f.bucket_name },
          { type: 'int8' as const, value: f.start } satisfies StatementParam
        ])
      ]
    })) {
      const decodedRows = rows.map((r) => models.BucketData.decode(r as any));

      for (const row of decodedRows) {
        const { bucket_name } = row;
        const rowSizeBytes = row.data ? row.data.length : 0;

        const sizeExceeded =
          chunkSizeBytes >= chunkSizeLimitBytes ||
          (currentChunk?.data.length && chunkSizeBytes + rowSizeBytes > chunkSizeLimitBytes) ||
          (currentChunk?.data.length ?? 0) >= batchRowLimit;

        if (currentChunk == null || currentChunk.bucket != bucket_name || sizeExceeded) {
          let start: string | undefined = undefined;
          if (currentChunk != null) {
            if (currentChunk.bucket == bucket_name) {
              currentChunk.has_more = true;
              start = currentChunk.next_after;
            }

            const yieldChunk = currentChunk;
            currentChunk = null;
            chunkSizeBytes = 0;
            yield { chunkData: yieldChunk, targetOp: targetOp };
            targetOp = null;
            if (batchRowCount >= batchRowLimit) {
              // We've yielded all the requested rows
              break;
            }
          }

          if (start == null) {
            const startOpId = dataBuckets.get(bucket_name);
            if (startOpId == null) {
              throw new framework.ServiceAssertionError(`data for unexpected bucket: ${bucket_name}`);
            }
            start = internalToExternalOpId(startOpId);
          }
          currentChunk = {
            bucket: bucket_name,
            after: start,
            // this is updated when we yield the batch
            has_more: false,
            data: [],
            // this is updated incrementally
            next_after: start
          };
          targetOp = null;
        }

        const entry = mapOpEntry(row);

        if (row.source_table && row.source_key) {
          entry.subkey = replicaIdToSubkey(row.source_table, storage.deserializeReplicaId(row.source_key));
        }

        if (row.target_op != null) {
          // MOVE, CLEAR
          const rowTargetOp = row.target_op;
          if (targetOp == null || rowTargetOp > targetOp) {
            targetOp = rowTargetOp;
          }
        }

        currentChunk.data.push(entry);
        currentChunk.next_after = entry.op_id;

        chunkSizeBytes += rowSizeBytes;

        // Manually track the total rows yielded
        batchRowCount++;
      }
    }

    if (currentChunk != null) {
      const yieldChunk = currentChunk;
      currentChunk = null;
      // This is the final chunk in the batch.
      // There may be more data if and only if the batch we retrieved isn't complete.
      // If batchRowCount == batchRowLimit, we don't actually know whether there is more data,
      // but it is safe to return true in that case.
      yieldChunk.has_more = batchRowCount >= batchRowLimit;
      yield { chunkData: yieldChunk, targetOp: targetOp };
      targetOp = null;
    }
  }

  async getChecksums(checkpoint: utils.InternalOpId, buckets: string[]): Promise<utils.ChecksumMap> {
    return this.checksumCache.getChecksumMap(checkpoint, buckets);
  }

  async terminate(options?: storage.TerminateOptions) {
    if (!options || options?.clearStorage) {
      await this.clear(options);
    }
    await this.db.sql`
      UPDATE sync_rules
      SET
        state = ${{ type: 'varchar', value: storage.SyncRuleState.TERMINATED }},
        snapshot_done = ${{ type: 'bool', value: false }}
      WHERE
        id = ${{ type: 'int4', value: this.group_id }}
    `.execute();
  }

  async getStatus(): Promise<storage.SyncRuleStatus> {
    const syncRulesRow = await this.db.sql`
      SELECT
        snapshot_done,
        snapshot_lsn,
        last_checkpoint_lsn,
        state
      FROM
        sync_rules
      WHERE
        id = ${{ type: 'int4', value: this.group_id }}
    `
      .decoded(pick(models.SyncRules, ['snapshot_done', 'last_checkpoint_lsn', 'state', 'snapshot_lsn']))
      .first();

    if (syncRulesRow == null) {
      throw new Error('Cannot find sync rules status');
    }

    return {
      snapshot_done: syncRulesRow.snapshot_done,
      active: syncRulesRow.state == storage.SyncRuleState.ACTIVE,
      checkpoint_lsn: syncRulesRow.last_checkpoint_lsn ?? null,
      snapshot_lsn: syncRulesRow.snapshot_lsn ?? null
    };
  }

  async clear(options?: storage.ClearStorageOptions): Promise<void> {
    // TODO: Cleanly abort the cleanup when the provided signal is aborted.
    await this.db.sql`
      UPDATE sync_rules
      SET
        snapshot_done = FALSE,
        last_checkpoint_lsn = NULL,
        last_checkpoint = NULL,
        no_checkpoint_before = NULL
      WHERE
        id = ${{ type: 'int4', value: this.group_id }}
    `.execute();

    await this.db.sql`
      DELETE FROM bucket_data
      WHERE
        group_id = ${{ type: 'int4', value: this.group_id }}
    `.execute();

    await this.db.sql`
      DELETE FROM bucket_parameters
      WHERE
        group_id = ${{ type: 'int4', value: this.group_id }}
    `.execute();

    await this.db.sql`
      DELETE FROM current_data
      WHERE
        group_id = ${{ type: 'int4', value: this.group_id }}
    `.execute();

    await this.db.sql`
      DELETE FROM source_tables
      WHERE
        group_id = ${{ type: 'int4', value: this.group_id }}
    `.execute();
  }

  private async getChecksumsInternal(batch: storage.FetchPartialBucketChecksum[]): Promise<storage.PartialChecksumMap> {
    if (batch.length == 0) {
      return new Map();
    }

    const rangedBatch = batch.map((b) => ({
      bucket: b.bucket,
      start: String(b.start ?? 0n),
      end: String(b.end)
    }));

    const results = await this.db.sql`
      WITH
        filter_data AS (
          SELECT
            FILTER ->> 'bucket' AS bucket_name,
            (FILTER ->> 'start')::BIGINT AS start_op_id,
            (FILTER ->> 'end')::BIGINT AS end_op_id
          FROM
            jsonb_array_elements(${{ type: 'jsonb', value: rangedBatch }}::jsonb) AS FILTER
        )
      SELECT
        b.bucket_name AS bucket,
        SUM(b.checksum) AS checksum_total,
        COUNT(*) AS total,
        MAX(
          CASE
            WHEN b.op = 'CLEAR' THEN 1
            ELSE 0
          END
        ) AS has_clear_op
      FROM
        bucket_data b
        JOIN filter_data f ON b.bucket_name = f.bucket_name
        AND b.op_id > f.start_op_id
        AND b.op_id <= f.end_op_id
      WHERE
        b.group_id = ${{ type: 'int4', value: this.group_id }}
      GROUP BY
        b.bucket_name;
    `.rows<{ bucket: string; checksum_total: bigint; total: bigint; has_clear_op: number }>();

    return new Map<string, storage.PartialChecksum>(
      results.map((doc) => {
        return [
          doc.bucket,
          {
            bucket: doc.bucket,
            partialCount: Number(doc.total),
            partialChecksum: Number(BigInt(doc.checksum_total) & 0xffffffffn) & 0xffffffff,
            isFullChecksum: doc.has_clear_op == 1
          } satisfies storage.PartialChecksum
        ];
      })
    );
  }

  async getActiveCheckpoint(): Promise<storage.ReplicationCheckpoint> {
    const activeCheckpoint = await this.db.sql`
      SELECT
        id,
        last_checkpoint,
        last_checkpoint_lsn
      FROM
        sync_rules
      WHERE
        state = ${{ value: storage.SyncRuleState.ACTIVE, type: 'varchar' }}
        OR state = ${{ value: storage.SyncRuleState.ERRORED, type: 'varchar' }}
      ORDER BY
        id DESC
      LIMIT
        1
    `
      .decoded(models.ActiveCheckpoint)
      .first();

    return this.makeActiveCheckpoint(activeCheckpoint);
  }

  async *watchCheckpointChanges(options: WatchWriteCheckpointOptions): AsyncIterable<storage.StorageCheckpointUpdate> {
    let lastCheckpoint: utils.InternalOpId | null = null;
    let lastWriteCheckpoint: bigint | null = null;

    const { signal, user_id } = options;

    const iter = wrapWithAbort(this.sharedIterator, signal);
    for await (const cp of iter) {
      const { checkpoint, lsn } = cp;

      // lsn changes are not important by itself.
      // What is important is:
      // 1. checkpoint (op_id) changes.
      // 2. write checkpoint changes for the specific user
      const lsnFilters: Record<string, string> = lsn ? { 1: lsn } : {};

      const currentWriteCheckpoint = await this.lastWriteCheckpoint({
        user_id,
        heads: {
          ...lsnFilters
        }
      });

      if (currentWriteCheckpoint == lastWriteCheckpoint && checkpoint == lastCheckpoint) {
        // No change - wait for next one
        // In some cases, many LSNs may be produced in a short time.
        // Add a delay to throttle the write checkpoint lookup a bit.
        await timers.setTimeout(20 + 10 * Math.random());
        continue;
      }

      lastWriteCheckpoint = currentWriteCheckpoint;
      lastCheckpoint = checkpoint;

      yield {
        base: cp,
        writeCheckpoint: currentWriteCheckpoint,
        update: CHECKPOINT_INVALIDATE_ALL
      };
    }
  }

  protected async *watchActiveCheckpoint(signal: AbortSignal): AsyncIterable<storage.ReplicationCheckpoint> {
    const doc = await this.db.sql`
      SELECT
        id,
        last_checkpoint,
        last_checkpoint_lsn
      FROM
        sync_rules
      WHERE
        state = ${{ value: storage.SyncRuleState.ACTIVE, type: 'varchar' }}
        OR state = ${{ value: storage.SyncRuleState.ERRORED, type: 'varchar' }}
      LIMIT
        1
    `
      .decoded(models.ActiveCheckpoint)
      .first();

    if (doc == null) {
      // Abort the connections - clients will have to retry later.
      throw new framework.ServiceError(framework.ErrorCode.PSYNC_S2302, 'No active sync rules available');
    }

    const sink = new LastValueSink<string>(undefined);

    const disposeListener = this.db.registerListener({
      notification: (notification) => sink.write(notification.payload)
    });

    signal.addEventListener('aborted', async () => {
      disposeListener();
      sink.end();
    });

    yield this.makeActiveCheckpoint(doc);

    let lastOp: storage.ReplicationCheckpoint | null = null;
    for await (const payload of sink.withSignal(signal)) {
      if (signal.aborted) {
        return;
      }

      const notification = models.ActiveCheckpointNotification.decode(payload);
      if (notification.active_checkpoint == null) {
        continue;
      }
      if (Number(notification.active_checkpoint.id) != doc.id) {
        // Active sync rules changed - abort and restart the stream
        break;
      }

      const activeCheckpoint = this.makeActiveCheckpoint(notification.active_checkpoint);

      if (lastOp == null || activeCheckpoint.lsn != lastOp.lsn || activeCheckpoint.checkpoint != lastOp.checkpoint) {
        lastOp = activeCheckpoint;
        yield activeCheckpoint;
      }
    }
  }

  async getCheckpointChanges(options: GetCheckpointChangesOptions): Promise<CheckpointChanges> {
    // We do not track individual changes yet
    return CHECKPOINT_INVALIDATE_ALL;
  }

  private makeActiveCheckpoint(row: models.ActiveCheckpointDecoded | null) {
    return {
      checkpoint: row?.last_checkpoint ?? 0n,
      lsn: row?.last_checkpoint_lsn ?? null
    } satisfies storage.ReplicationCheckpoint;
  }
}
