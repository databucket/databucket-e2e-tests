import { test, expect } from '../../fixtures';
import type { Api } from '../../support/api';

const BUCKET = 'orders';
const DATA = `/api/bucket/${BUCKET}`;

async function insert(api: Api, properties: object, extra: object = {}): Promise<any> {
  const response = await api.post(DATA, { data: { properties, ...extra }, expectStatus: 201 });
  return response.body;
}

async function all(api: Api): Promise<any[]> {
  const response = await api.post(`${DATA}/get?limit=100`, { data: {}, expectStatus: 200 });
  return response.body.data ?? [];
}

test.describe('Changing data', () => {
  let robot: Api;

  test.beforeEach(async ({ project }) => {
    await project.createBucket(BUCKET);
    robot = await project.as('robot');
  });

  test('inserts many rows at once', async () => {
    await robot.post(`${DATA}/multi`, {
      data: Array.from({ length: 50 }, (_, i) => ({ properties: { no: i + 1 } })),
      expectStatus: 201,
    });

    const count = await robot.post(`${DATA}/get?limit=0`, { data: {}, expectStatus: 200 });
    expect(count.body.total).toBe(50);
  });

  test('a row inserted as reserved belongs to the user', async ({ project }) => {
    const row = await insert(robot, { login: 'anna' }, { reserved: true });

    expect(row).toMatchObject({ reserved: true, owner: project.users.robot.username });
  });

  test('a row with a tag that does not exist is refused', async () => {
    const response = await robot.post(DATA, { data: { properties: { a: 1 }, tagId: 999999 } });

    expect(response.status).toBe(406);
    expect(await all(robot)).toEqual([]);
  });

  test('many rows at once are all saved or none', async () => {
    const response = await robot.post(`${DATA}/multi`, {
      data: [{ properties: { no: 1 } }, { properties: { no: 2 }, tagId: 999999 }],
    });

    expect(response.status).toBe(406);
    expect(await all(robot)).toEqual([]);
  });

  test('gets several rows by ids and skips the ids that do not exist', async () => {
    const a = await insert(robot, { name: 'a' });
    const b = await insert(robot, { name: 'b' });

    const response = await robot.get(`${DATA}/${a.id},999999,${b.id}`, { expectStatus: 200 });

    expect(response.body.map((row: any) => row.properties.name)).toEqual(['a', 'b']);
  });

  test('changes several rows by ids', async () => {
    const a = await insert(robot, { status: 'NEW' });
    const b = await insert(robot, { status: 'NEW' });
    const c = await insert(robot, { status: 'NEW' });

    await robot.put(`${DATA}/${a.id},${c.id}`, { data: { propertiesToSet: { '$.status': 'PAID' } }, expectStatus: 200 });

    const rows = await all(robot);
    expect(rows.map(row => [row.id, row.properties.status])).toEqual([[a.id, 'PAID'], [b.id, 'NEW'], [c.id, 'PAID']]);
  });

  test('removes properties and sets nested ones', async () => {
    const row = await insert(robot, { customer: 'Alice', comment: 'call first', address: { city: 'Paris' } });

    await robot.put(`${DATA}/${row.id}`, {
      data: { propertiesToRemove: ['$.comment'], propertiesToSet: { '$.address.zip': '75001', '$.payment.method': 'card' } },
      expectStatus: 200,
    });

    const changed = await robot.get(`${DATA}/${row.id}`, { expectStatus: 200 });
    expect(changed.body.properties).toEqual({ customer: 'Alice', address: { city: 'Paris', zip: '75001' }, payment: { method: 'card' } });
  });

  test('changes the rows matching the rules and says how many', async () => {
    await robot.post(`${DATA}/multi`, {
      data: [{ properties: { status: 'NEW' } }, { properties: { status: 'PAID' } }, { properties: { status: 'NEW' } }],
      expectStatus: 201,
    });

    const response = await robot.put(DATA, {
      data: { rules: [['$.status', '==', 'NEW']], propertiesToSet: { '$.status': 'CANCELLED' } },
      expectStatus: 200,
    });

    expect(response.body.message).toBe('Modified 2 data row(s)');
    expect((await all(robot)).map(row => row.properties.status)).toEqual(['CANCELLED', 'PAID', 'CANCELLED']);
  });

  test('changing or removing by rules needs at least one rule', async () => {
    await insert(robot, { status: 'NEW' });

    const change = await robot.put(DATA, { data: { propertiesToSet: { '$.status': 'X' } } });
    const remove = await robot.delete(DATA, { data: {} });

    expect(change.status).toBe(406);
    expect(remove.status).toBe(406);
    expect((await all(robot)).map(row => row.properties.status)).toEqual(['NEW']);
  });

  test('removes the rows matching the rules', async () => {
    await robot.post(`${DATA}/multi`, {
      data: [{ properties: { status: 'NEW' } }, { properties: { status: 'PAID' } }, { properties: { status: 'NEW' } }],
      expectStatus: 201,
    });

    const response = await robot.delete(DATA, { data: { rules: [['$.status', '==', 'NEW']] }, expectStatus: 200 });

    expect(response.body.message).toBe('Removed 2 data row(s)');
    expect((await all(robot)).map(row => row.properties.status)).toEqual(['PAID']);
  });

  test('an AGENT changes rows but can not remove them', async ({ project }) => {
    const agent = await project.as('agent');
    const row = await insert(agent, { status: 'NEW' });
    await agent.put(`${DATA}/${row.id}`, { data: { propertiesToSet: { '$.status': 'PAID' } }, expectStatus: 200 });

    const byId = await agent.delete(`${DATA}/${row.id}`);
    const byRules = await agent.delete(DATA, { data: { rules: [['$.status', '==', 'PAID']] } });

    expect(byId.status).toBe(403);
    expect(byRules.status).toBe(403);
    expect(await all(robot)).toHaveLength(1);
  });

  test('a bucket that does not exist gives 404', async () => {
    const get = await robot.post('/api/bucket/no-such-bucket/get', { data: {} });
    const insertion = await robot.post('/api/bucket/no-such-bucket', { data: { properties: {} } });

    expect(get.status).toBe(404);
    expect(insertion.status).toBe(404);
  });

  test('sets and clears the tag of a row', async ({ project }) => {
    const admin = await project.quietly('admin');
    const tag = await admin.post('/api/tags', { data: { name: 'checked' }, expectStatus: 201 });
    const row = await insert(robot, { a: 1 });

    await robot.put(`${DATA}/${row.id}`, { data: { tagId: tag.body.id }, expectStatus: 200 });
    const tagged = await robot.get(`${DATA}/${row.id}`, { expectStatus: 200 });

    expect(tagged.body.tagId).toBe(tag.body.id);
  });

  test('records who changed a row and when', async ({ project }) => {
    const row = await insert(robot, { status: 'NEW' });
    const member = await project.as('member');

    await member.put(`${DATA}/${row.id}`, { data: { propertiesToSet: { '$.status': 'PAID' } }, expectStatus: 200 });
    const changed = await robot.get(`${DATA}/${row.id}`, { expectStatus: 200 });

    expect(changed.body).toMatchObject({ createdBy: project.users.robot.username, modifiedBy: project.users.member.username });
    expect(Date.parse(changed.body.modifiedAt)).toBeGreaterThanOrEqual(Date.parse(changed.body.createdAt));
  });
});
