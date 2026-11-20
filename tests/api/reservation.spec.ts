import { test, expect } from '../../fixtures';
import type { Api } from '../../support/api';

const BUCKET = 'accounts';
const DATA = `/api/bucket/${BUCKET}`;

async function seed(api: Api, count: number, properties: (i: number) => object = i => ({ login: `user-${i}` })) {
  await api.post(`${DATA}/multi`, {
    data: Array.from({ length: count }, (_, i) => ({ properties: properties(i + 1) })),
    expectStatus: 201,
  });
}

async function reserve(api: Api, query: string, data: object = {}) {
  return api.post(`${DATA}/reserve?${query}`, { data, expectStatus: 200 });
}

test.describe('Reservation', () => {
  let robot: Api;

  test.beforeEach(async ({ project }) => {
    await project.createBucket(BUCKET);
    robot = await project.as('robot');
  });

  test('limit 0 only counts the free rows', async ({ project }) => {
    await seed(await project.quietly('robot'), 4);

    const count = await reserve(robot, 'limit=0');
    const again = await reserve(robot, 'limit=0');

    expect(count.body).toMatchObject({ reserved: 0, available: 4 });
    expect(again.body.available).toBe(4);
  });

  test('says how many free rows are left, unless count=false', async ({ project }) => {
    await seed(await project.quietly('robot'), 5);

    const counted = await reserve(robot, 'limit=2');
    const notCounted = await reserve(robot, 'limit=1&count=false');

    expect(counted.body).toMatchObject({ reserved: 2, available: 3 });
    expect(notCounted.body.reserved).toBe(1);
    expect(notCounted.body.available).toBeUndefined();
  });

  test('reserves only the rows matching the rules', async ({ project }) => {
    await seed(await project.quietly('robot'), 6, i => ({ login: `user-${i}`, plan: i % 2 ? 'free' : 'premium' }));

    const response = await reserve(robot, 'limit=10', { rules: [['$.plan', '==', 'premium']] });

    expect(response.body.reserved).toBe(3);
    expect(response.body.data.map((row: any) => row.properties.plan)).toEqual(['premium', 'premium', 'premium']);
    expect(response.body.available).toBe(0);
  });

  test('when nothing is free there is a message, not an error', async ({ project }) => {
    await seed(await project.quietly('robot'), 1);
    await reserve(robot, 'limit=1');

    const response = await reserve(robot, 'limit=1');

    expect(response.body).toMatchObject({ reserved: 0, available: 0, message: 'No data matches the rules!' });
  });

  test('rows reserved by one user are not given to another', async ({ project }) => {
    await seed(await project.quietly('robot'), 3);
    const member = await project.as('member');

    const memberGot = await reserve(member, 'limit=2');
    const robotGot = await reserve(robot, 'limit=5');

    const memberIds = memberGot.body.data.map((row: any) => row.id);
    const robotIds = robotGot.body.data.map((row: any) => row.id);
    expect(memberIds).toHaveLength(2);
    expect(robotIds).toHaveLength(1);
    expect(robotIds.filter((id: number) => memberIds.includes(id))).toEqual([]);
    expect(robotGot.body.data[0].owner).toBe(project.users.robot.username);
  });

  test('parallel reservations never get the same row', async ({ project }) => {
    await seed(await project.quietly('robot'), 30);
    const clients = [await project.quietly('robot'), await project.quietly('member'), await project.quietly('agent')];

    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      clients[i % clients.length].post(`${DATA}/reserve?limit=1&sort=random`, { data: {}, expectStatus: 200 })));

    const ids = responses.flatMap(response => (response.body.data ?? []).map((row: any) => row.id));
    expect(new Set(ids).size).toBe(ids.length);
    // every row is taken once at most; a reservation that met only taken rows got none
    expect(ids.length).toBeGreaterThan(0);
    const left = await reserve(robot, 'limit=0');
    expect(left.body.available).toBe(30 - ids.length);
  });

  test('released rows can be reserved again', async ({ project }) => {
    await seed(await project.quietly('robot'), 1);
    const member = await project.as('member');
    const taken = await reserve(robot, 'limit=1');
    const id = taken.body.data[0].id;

    await robot.put(`${DATA}/${id}`, { data: { reserved: false }, expectStatus: 200 });
    const again = await reserve(member, 'limit=1');

    expect(again.body.data[0]).toMatchObject({ id, reserved: true, owner: project.users.member.username });
  });

  test('an ADMIN reserves rows for another user; others can not', async ({ project }) => {
    await seed(await project.quietly('robot'), 2);
    const admin = await project.as('admin');

    const forMember = await reserve(admin, 'limit=1', { targetOwnerUsername: project.users.member.username });
    const robotTries = await reserve(robot, 'limit=1', { targetOwnerUsername: project.users.member.username });

    expect(forMember.body.data[0].owner).toBe(project.users.member.username);
    expect(robotTries.body.data[0].owner).toBe(project.users.robot.username);
  });

  test('a negative limit is refused', async () => {
    const response = await robot.post(`${DATA}/reserve?limit=-1`, { data: {} });

    expect(response.status).toBe(406);
  });

  test('reserving by rules changes only the free rows', async ({ project }) => {
    await seed(await project.quietly('robot'), 3);
    const member = await project.as('member');
    await reserve(member, 'limit=1');

    const response = await robot.put(DATA, { data: { rules: [['id', '>', 0]], reserved: true }, expectStatus: 200 });

    expect(response.body.message).toBe('Modified 2 data row(s)');
    const owners = await robot.post(`${DATA}/get?limit=10`, { data: {}, expectStatus: 200 });
    expect(owners.body.data.map((row: any) => row.owner)).toEqual([
      project.users.member.username, project.users.robot.username, project.users.robot.username,
    ]);
  });

  test('in a bucket with protected data each user sees only the rows they reserved', async ({ project }) => {
    await project.createBucket('vault', { protectedData: true });
    const admin = await project.quietly('admin');
    await admin.post('/api/bucket/vault/multi', {
      data: [{ properties: { login: 'a' } }, { properties: { login: 'b' } }, { properties: { login: 'c' } }],
      expectStatus: 201,
    });
    const member = await project.as('member');

    const reserved = await member.post('/api/bucket/vault/reserve?limit=1', { data: {}, expectStatus: 200 });
    const memberSees = await member.post('/api/bucket/vault/get?limit=10', { data: {}, expectStatus: 200 });
    const robotSees = await robot.post('/api/bucket/vault/get?limit=10', { data: {}, expectStatus: 200 });
    const adminSees = await admin.post('/api/bucket/vault/get?limit=10', { data: {}, expectStatus: 200 });

    // free rows are counted for everyone, as anyone may reserve them
    expect(reserved.body.available).toBe(2);
    expect(memberSees.body.data.map((row: any) => row.properties.login)).toEqual([reserved.body.data[0].properties.login]);
    expect(robotSees.body.data ?? []).toEqual([]);
    expect(adminSees.body.total).toBe(3);
  });
});
