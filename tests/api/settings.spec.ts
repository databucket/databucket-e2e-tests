import { test, expect } from '../../fixtures';
import type { Api } from '../../support/api';
import { ROLE } from '../../support/env';

// The settings of a project (ADMIN): buckets, classes, enums, tags, views.
const BUCKET = { icon: { name: 'Storage' }, roleId: ROLE.AGENT };

async function createBucket(admin: Api, name: string, extra: object = {}) {
  return admin.post('/api/buckets', { data: { ...BUCKET, name, ...extra } });
}

test.describe('Settings: buckets', () => {
  let admin: Api;

  test.beforeEach(async ({ project }) => {
    admin = await project.as('admin');
  });

  test('a bucket name is unique in the project', async () => {
    await createBucket(admin, 'orders').then(r => expect(r.status).toBe(201));

    const again = await createBucket(admin, 'orders');

    expect(again.status).toBe(406);
  });

  test('a bucket name has at most 30 characters', async () => {
    const response = await createBucket(admin, 'x'.repeat(31));

    expect(response.status).toBe(400);
  });

  test('a renamed bucket keeps its data under the new name', async ({ project }) => {
    const created = await createBucket(admin, 'orders-old');
    const robot = await project.as('robot');
    await robot.post('/api/bucket/orders-old', { data: { properties: { no: 1 } }, expectStatus: 201 });

    await admin.put('/api/buckets', { data: { ...created.body, name: 'orders-new' }, expectStatus: 200 });

    expect((await robot.post('/api/bucket/orders-old/get', { data: {} })).status).toBe(404);
    const data = await robot.post('/api/bucket/orders-new/get?limit=10', { data: {}, expectStatus: 200 });
    expect(data.body.data.map((row: any) => row.properties.no)).toEqual([1]);
  });

  test('a removed bucket is gone, and its name can be used again for a new, empty bucket', async ({ project }) => {
    const created = await createBucket(admin, 'temp');
    const robot = await project.as('robot');
    await robot.post('/api/bucket/temp', { data: { properties: { no: 1 } }, expectStatus: 201 });

    await admin.delete(`/api/buckets/${created.body.id}`, { expectStatus: 204 });
    expect((await robot.post('/api/bucket/temp/get', { data: {} })).status).toBe(404);

    await createBucket(admin, 'temp').then(r => expect(r.status).toBe(201));
    const data = await robot.post('/api/bucket/temp/get?limit=10', { data: {}, expectStatus: 200 });
    expect(data.body.total).toBe(0);
  });

  test('switching the history off stops recording the changes', async ({ project }) => {
    const created = await createBucket(admin, 'orders', { history: true });
    const robot = await project.as('robot');
    const row = await robot.post('/api/bucket/orders', { data: { properties: { status: 'NEW' } }, expectStatus: 201 });

    await admin.put('/api/buckets', { data: { ...created.body, history: false }, expectStatus: 200 });
    await robot.put(`/api/bucket/orders/${row.body.id}`, { data: { propertiesToSet: { '$.status': 'PAID' } }, expectStatus: 200 });

    const history = await robot.get(`/api/bucket/orders/${row.body.id}/history`, { expectStatus: 200 });
    expect(history.body).toHaveLength(1);
  });

  test('indexed properties: a valid path and type, at most 5', async () => {
    const badPath = await createBucket(admin, 'idx-1', { indexedProperties: [{ path: "$.a'); DROP TABLE tags; --", type: 'text' }] });
    const badType = await createBucket(admin, 'idx-2', { indexedProperties: [{ path: '$.a', type: 'date' }] });
    const tooMany = await createBucket(admin, 'idx-3', {
      indexedProperties: ['a', 'b', 'c', 'd', 'e', 'f'].map(p => ({ path: `$.${p}`, type: 'text' })),
    });
    const fine = await createBucket(admin, 'idx-4', { indexedProperties: [{ path: '$.login', type: 'text' }, { path: '$.age', type: 'number' }] });

    expect([badPath.status, badType.status, tooMany.status]).toEqual([400, 400, 400]);
    expect(fine.status).toBe(201);
    expect(fine.body.indexedProperties).toEqual([{ path: '$.login', type: 'text' }, { path: '$.age', type: 'number' }]);
  });
});

test.describe('Settings: classes, enums, tags, views', () => {
  let admin: Api;

  test.beforeEach(async ({ project }) => {
    admin = await project.as('admin');
  });

  test('a class describes the fields of a bucket; its name is unique', async () => {
    const configuration = [{ title: 'Login', path: '$.login', type: 'string', uuid: 'u-login' }];
    const created = await admin.post('/api/classes', { data: { name: 'user', configuration }, expectStatus: 201 });
    const again = await admin.post('/api/classes', { data: { name: 'user', configuration } });

    expect(created.body).toMatchObject({ name: 'user', configuration });
    expect(again.status).toBe(406);
  });

  test('an enum keeps its items in order', async () => {
    const items = [{ value: 'gold', text: 'Gold' }, { value: 'silver', text: 'Silver' }, { value: 'bronze', text: 'Bronze' }];
    await admin.post('/api/enums', { data: { name: 'levels', items }, expectStatus: 201 });

    const enums = await admin.get('/api/enums', { expectStatus: 200 });

    const levels = enums.body.find((e: any) => e.name === 'levels');
    expect(levels.items.map((item: any) => item.value)).toEqual(['gold', 'silver', 'bronze']);
  });

  test('a tag name is unique; a tag in use can be renamed', async ({ project }) => {
    const tag = await admin.post('/api/tags', { data: { name: 'new' }, expectStatus: 201 });
    const again = await admin.post('/api/tags', { data: { name: 'new' } });
    await project.createBucket('orders');
    const robot = await project.quietly('robot');
    const row = await robot.post('/api/bucket/orders', { data: { properties: {}, tagId: tag.body.id }, expectStatus: 201 });

    await admin.put('/api/tags', { data: { ...tag.body, name: 'fresh' }, expectStatus: 200 });

    expect(again.status).toBe(406);
    const read = await robot.get(`/api/bucket/orders/${row.body.id}`, { expectStatus: 200 });
    expect(read.body.tagId).toBe(tag.body.id);
    const tags = await admin.get('/api/tags', { expectStatus: 200 });
    expect(tags.body.map((t: any) => t.name)).toEqual(['fresh']);
  });

  test('a view starts sorted only by an allowed field', async ({ project }) => {
    const bucketId = await project.createBucket('orders');
    const columns = await admin.post('/api/columns', { data: { name: 'cols', configuration: { columns: [], properties: [] } }, expectStatus: 201 });
    const view = { name: 'all', columnsId: columns.body.id, bucketsIds: [bucketId], roleId: ROLE.MEMBER };

    const bad = await admin.post('/api/views', { data: { ...view, sort: 'desc(password)' } });
    const injected = await admin.post('/api/views', { data: { ...view, sort: "asc($.a'))--)" } });
    const good = await admin.post('/api/views', { data: { ...view, sort: 'asc($.customer.name)' } });

    expect(bad.status).toBe(400);
    expect(injected.status).toBe(400);
    expect(good.status).toBe(201);
    expect(good.body.sort).toBe('asc($.customer.name)');
  });
});
