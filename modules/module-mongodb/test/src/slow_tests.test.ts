import { setTimeout } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';

import { mongo } from '@powersync/lib-service-mongodb';
import { storage } from '@powersync/service-core';

import { ChangeStreamTestContext, setSnapshotHistorySeconds } from './change_stream_utils.js';
import { env } from './env.js';
import { describeWithStorage } from './util.js';

describe.runIf(env.CI || env.SLOW_TESTS)('change stream slow tests', { timeout: 60_000 }, function () {
  describeWithStorage({}, defineSlowTests);
});

function defineSlowTests(factory: storage.TestStorageFactory) {
  test('replicating snapshot with lots of data', async () => {
    await using context = await ChangeStreamTestContext.open(factory);
    // Test with low minSnapshotHistoryWindowInSeconds, to trigger:
    // > Read timestamp .. is older than the oldest available timestamp.
    // This happened when we had {snapshot: true} in the initial
    // snapshot session.
    await using _ = await setSnapshotHistorySeconds(context.client, 1);
    const { db } = context;
    await context.updateSyncRules(`
bucket_definitions:
  global:
    data:
      - SELECT _id as id, description, num FROM "test_data1"
      - SELECT _id as id, description, num FROM "test_data2"
      `);

    const collection1 = db.collection('test_data1');
    const collection2 = db.collection('test_data2');

    let operations: mongo.AnyBulkWriteOperation[] = [];
    for (let i = 0; i < 10_000; i++) {
      operations.push({ insertOne: { document: { description: `pre${i}`, num: i } } });
    }
    await collection1.bulkWrite(operations);
    await collection2.bulkWrite(operations);

    await context.replicateSnapshot();
    context.startStreaming();
    const checksum = await context.getChecksum('global[]');
    expect(checksum).toMatchObject({
      count: 20_000
    });
  });

  test('writes concurrently with snapshot', async () => {
    // If there is an issue with snapshotTime (the start LSN for the
    // changestream), we may miss updates, which this test would
    // hopefully catch.

    await using context = await ChangeStreamTestContext.open(factory);
    const { db } = context;
    await context.updateSyncRules(`
bucket_definitions:
  global:
    data:
      - SELECT _id as id, description, num FROM "test_data"
      `);

    const collection = db.collection('test_data');

    let operations: mongo.AnyBulkWriteOperation[] = [];
    for (let i = 0; i < 5_000; i++) {
      operations.push({ insertOne: { document: { description: `pre${i}`, num: i } } });
    }
    await collection.bulkWrite(operations);

    const snapshotPromise = context.replicateSnapshot();

    for (let i = 49; i >= 0; i--) {
      await collection.updateMany(
        { num: { $gte: i * 100, $lt: i * 100 + 100 } },
        { $set: { description: 'updated' + i } }
      );
      await setTimeout(20);
    }

    await snapshotPromise;
    context.startStreaming();

    const data = await context.getBucketData('global[]');

    const preDocuments = data.filter((d: any) => JSON.parse(d.data! as string).description.startsWith('pre')).length;
    const updatedDocuments = data.filter((d: any) =>
      JSON.parse(d.data! as string).description.startsWith('updated')
    ).length;

    // If the test works properly, preDocuments should be around 2000-3000.
    // The total should be around 9000-9900.
    // However, it is very sensitive to timing, so we allow a wide range.
    // updatedDocuments must be strictly >= 5000, otherwise something broke.
    expect(updatedDocuments).toBeGreaterThanOrEqual(5_000);
    expect(preDocuments).toBeLessThanOrEqual(5_000);
  });
}
