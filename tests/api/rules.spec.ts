import { test, expect } from '../../fixtures';
import type { Api } from '../../support/api';

// The rules of a search: [left, operator, right], combined with 'and'; {"or": [...]}, {"and": [...]}, {"!": rule}.
const BUCKET = 'people';
const DATA = `/api/bucket/${BUCKET}`;

const PEOPLE = [
  { name: 'Anna', city: 'Paris', age: 34, vip: true, address: { zip: '75001' } },
  { name: 'bob', city: 'Berlin', age: 17, vip: false, address: { zip: '10115' } },
  { name: 'Carol', city: 'Paris', age: 51, vip: false, email: null },
  { name: 'Dave', city: 'Warsaw', age: 28, vip: true, price: '$10' },
  { name: "O'Brien", city: 'Dublin', age: 40 },
];

/** The names of the people matching the search (rules and/or logic), in the order of the ids. */
async function names(api: Api, search: object): Promise<string[]> {
  const response = await api.post(`${DATA}/get?limit=100`, { data: search, expectStatus: 200 });
  return response.body.data.map((row: any) => row.properties.name);
}

test.describe('Search rules', () => {
  let robot: Api;

  test.beforeEach(async ({ project }) => {
    await project.createBucket(BUCKET);
    robot = await project.as('robot');
    const quiet = await project.quietly('robot');
    await quiet.post(`${DATA}/multi`, { data: PEOPLE.map(properties => ({ properties })), expectStatus: 201 });
  });

  test('== and != compare texts', async () => {
    expect(await names(robot, { rules: [['$.city', '==', 'Paris']] })).toEqual(['Anna', 'Carol']);
    expect(await names(robot, { rules: [['$.city', '!=', 'Paris']] })).toEqual(['bob', 'Dave', "O'Brien"]);
  });

  test('<, <=, >, >= compare numbers', async () => {
    expect(await names(robot, { rules: [['$.age', '>', 30], ['$.age', '<=', 51]] })).toEqual(['Anna', 'Carol', "O'Brien"]);
    expect(await names(robot, { rules: [['$.age', '<', 18]] })).toEqual(['bob']);
    expect(await names(robot, { rules: [['$.age', '>=', 40]] })).toEqual(['Carol', "O'Brien"]);
  });

  test('in and !in take a list', async () => {
    expect(await names(robot, { rules: [['$.city', 'in', ['Berlin', 'Warsaw']]] })).toEqual(['bob', 'Dave']);
    expect(await names(robot, { rules: [['$.city', '!in', ['Berlin', 'Warsaw']]] })).toEqual(['Anna', 'Carol', "O'Brien"]);
  });

  test('like and !like match with % and _', async () => {
    expect(await names(robot, { rules: [['$.name', 'like', 'C%']] })).toEqual(['Carol']);
    expect(await names(robot, { rules: [['$.name', 'like', '_ob']] })).toEqual(['bob']);
    expect(await names(robot, { rules: [['$.name', '!like', '%a%']] })).toEqual(['bob', "O'Brien"]);
  });

  test('regular expressions: ~ is case-sensitive, ~* is not', async () => {
    expect(await names(robot, { rules: [['$.name', '~', '^[A-C]']] })).toEqual(['Anna', 'Carol']);
    expect(await names(robot, { rules: [['$.name', '~*', '^b']] })).toEqual(['bob']);
    expect(await names(robot, { rules: [['$.name', '!~', '^[A-Z]']] })).toEqual(['bob']);
  });

  test('booleans and nested properties', async () => {
    expect(await names(robot, { rules: [['$.vip', '==', true]] })).toEqual(['Anna', 'Dave']);
    expect(await names(robot, { rules: [['$.address.zip', '==', '75001']] })).toEqual(['Anna']);
  });

  test('or, and and ! combine rules', async () => {
    expect(await names(robot, {
      rules: [{ or: [['$.city', '==', 'Berlin'], { and: [['$.city', '==', 'Paris'], ['$.age', '>', 40]] }] }],
    })).toEqual(['bob', 'Carol']);
    expect(await names(robot, { rules: [{ '!': ['$.city', '==', 'Paris'] }] })).toEqual(['bob', 'Dave', "O'Brien"]);
  });

  test('is null and is not null: a missing property is null too', async () => {
    expect(await names(robot, { rules: [['$.price', 'is not', null]] })).toEqual(['Dave']);
    expect(await names(robot, { rules: [['$.email', 'is', null]] })).toEqual(PEOPLE.map(p => p.name));
  });

  test('a text starting with $ is a value inside in, not a property', async () => {
    expect(await names(robot, { rules: [['$.price', 'in', ['$10']]] })).toEqual(['Dave']);
  });

  test('rules on the fields of a row: id, createdBy, reserved', async ({ project }) => {
    const all = await robot.post(`${DATA}/get?limit=100`, { data: {}, expectStatus: 200 });
    const carol = all.body.data.find((row: any) => row.properties.name === 'Carol');

    expect(await names(robot, { rules: [['id', '==', carol.id]] })).toEqual(['Carol']);
    expect(await names(robot, { rules: [['createdBy', '==', project.users.robot.username], ['$.age', '<', 18]] })).toEqual(['bob']);
    expect(await names(robot, { rules: [['reserved', '==', true]] })).toEqual([]);
  });

  test('@currentUser is the signed-in user', async ({ project }) => {
    const member = await project.as('member');
    await member.post(`${DATA}/reserve?limit=1`, { data: { rules: [['$.name', '==', 'Dave']] }, expectStatus: 200 });

    expect(await names(member, { rules: [['owner', '==', '@currentUser']] })).toEqual(['Dave']);
    expect(await names(robot, { rules: [['owner', '==', '@currentUser']] })).toEqual([]);
  });

  test('rules and logic given together must both match', async () => {
    expect(await names(robot, {
      rules: [['$.city', '==', 'Paris']],
      logic: { '>': [{ var: '$.age' }, 40] },
    })).toEqual(['Carol']);
  });

  test('a value with quotes is only a value, never SQL', async () => {
    expect(await names(robot, { rules: [['$.name', '==', "O'Brien"]] })).toEqual(["O'Brien"]);
    expect(await names(robot, { rules: [['$.name', '==', "x' OR '1'='1"]] })).toEqual([]);
    expect(await names(robot, { rules: [['$.name', 'like', "%'; DROP TABLE tags; --"]] })).toEqual([]);
    // the table is still there
    expect(await names(robot, { rules: [['$.city', '==', 'Warsaw']] })).toEqual(['Dave']);
  });

  test('a rule written as SQL text is refused', async () => {
    const response = await robot.post(`${DATA}/get`, { data: { rules: ["properties->>'city' = 'Paris'"] } });

    expect(response.status).toBe(400);
  });

  test('an unknown field or operator is refused', async () => {
    const field = await robot.post(`${DATA}/get`, { data: { rules: [['password', '==', 'x']] } });
    const operator = await robot.post(`${DATA}/get`, { data: { rules: [['$.age', '===', 1]] } });

    expect(field.status).toBe(400);
    expect(operator.status).toBe(400);
  });

  test('rules on the tag of the rows', async ({ project }) => {
    const admin = await project.quietly('admin');
    const tag = await admin.post('/api/tags', { data: { name: 'vip-checked' }, expectStatus: 201 });
    await robot.put(DATA, { data: { rules: [['$.vip', '==', true]], tagId: tag.body.id }, expectStatus: 200 });

    expect(await names(robot, { rules: [['tagId', '==', tag.body.id]] })).toEqual(['Anna', 'Dave']);
    expect(await names(robot, { rules: [['tagId', 'is', null]] })).toEqual(['bob', 'Carol', "O'Brien"]);
  });
});
