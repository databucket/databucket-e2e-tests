import { test, expect } from '../../fixtures';
import type { Api } from '../../support/api';

const BUCKET = 'orders';
const DATA = `/api/bucket/${BUCKET}`;

async function insert(api: Api, properties: object, bucket = BUCKET): Promise<number> {
  const response = await api.post(`/api/bucket/${bucket}`, { data: { properties }, expectStatus: 201 });
  return response.body.id;
}

async function setStatus(api: Api, id: number, status: string, bucket = BUCKET) {
  await api.put(`/api/bucket/${bucket}/${id}`, { data: { propertiesToSet: { '$.status': status } }, expectStatus: 200 });
}

async function historyOf(api: Api, id: number, bucket = BUCKET): Promise<any[]> {
  const response = await api.get(`/api/bucket/${bucket}/${id}/history`, { expectStatus: 200 });
  return response.body;
}

test.describe('History of changes', () => {
  let robot: Api;

  test.beforeEach(async ({ project }) => {
    await project.createBucket(BUCKET, { history: true });
    robot = await project.as('robot');
  });

  test('gives the properties of a row as they were in each version', async () => {
    const id = await insert(robot, { status: 'NEW' });
    await setStatus(robot, id, 'PAID');
    await setStatus(robot, id, 'SHIPPED');
    const entries = await historyOf(robot, id);

    const versions = await robot.get(`${DATA}/${id}/history/${entries.map(entry => entry.id).join(',')}`, { expectStatus: 200 });

    expect(versions.body.map((version: any) => version.properties.status)).toEqual(['NEW', 'PAID', 'SHIPPED']);
  });

  test('records reservations and their owner', async ({ project }) => {
    const id = await insert(robot, { login: 'anna' });
    const member = await project.quietly('member');
    await member.post(`${DATA}/reserve?limit=1`, { data: {}, expectStatus: 200 });

    const entries = await historyOf(robot, id);

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ reserved: true, modified_by: project.users.member.username });
  });

  test('a ROBOT clears the history of a row; the row stays', async () => {
    const id = await insert(robot, { status: 'NEW' });
    await setStatus(robot, id, 'PAID');

    await robot.delete(`${DATA}/${id}/history/clear`, { expectStatus: 200 });

    expect(await historyOf(robot, id)).toEqual([]);
    const row = await robot.get(`${DATA}/${id}`, { expectStatus: 200 });
    expect(row.body.properties.status).toBe('PAID');
  });

  test('an AGENT can not clear the history', async ({ project }) => {
    const id = await insert(robot, { status: 'NEW' });
    const agent = await project.as('agent');

    const one = await agent.delete(`${DATA}/${id}/history/clear`);
    const byRules = await agent.delete(`${DATA}/history/clear`, { data: { rules: [['id', '==', id]] } });

    expect(one.status).toBe(403);
    expect(byRules.status).toBe(403);
    expect(await historyOf(robot, id)).toHaveLength(1);
  });

  test('clears the history of the rows matching the rules only', async () => {
    const paid = await insert(robot, { status: 'NEW', customer: 'Alice' });
    const other = await insert(robot, { status: 'NEW', customer: 'Bob' });
    await setStatus(robot, paid, 'PAID');
    await setStatus(robot, other, 'PAID');

    await robot.delete(`${DATA}/history/clear`, { data: { rules: [['$.customer', '==', 'Alice']] }, expectStatus: 200 });

    expect(await historyOf(robot, paid)).toEqual([]);
    expect(await historyOf(robot, other)).toHaveLength(2);
  });

  test('a bucket without history keeps no entries', async ({ project }) => {
    await project.createBucket('plain', { history: false });
    const id = await insert(robot, { status: 'NEW' }, 'plain');
    await setStatus(robot, id, 'PAID', 'plain');

    expect(await historyOf(robot, id, 'plain')).toEqual([]);
  });

  test('searches the entries by who changed the rows', async ({ project }) => {
    const id = await insert(robot, { status: 'NEW' });
    const member = await project.quietly('member');
    await setStatus(member, id, 'PAID');
    await setStatus(robot, id, 'SHIPPED');

    const byMember = await robot.post(`${DATA}/history/get?limit=10`, {
      data: { historyRules: [['modifiedBy', '==', project.users.member.username]] },
      expectStatus: 200,
    });

    expect(byMember.body.total).toBe(1);
    expect(byMember.body.history[0]).toMatchObject({ dataId: id, modifiedBy: project.users.member.username });
  });

  test('removing a row removes its history', async () => {
    const id = await insert(robot, { status: 'NEW' });
    await setStatus(robot, id, 'PAID');

    await robot.delete(`${DATA}/${id}`, { expectStatus: 200 });

    const search = await robot.post(`${DATA}/history/get?limit=10`, {
      data: { historyRules: [['dataId', '==', id]] },
      expectStatus: 200,
    });
    expect(search.body.total).toBe(0);
  });
});
