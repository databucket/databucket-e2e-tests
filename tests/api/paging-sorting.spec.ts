import { test, expect } from '../../fixtures';
import type { Api } from '../../support/api';

const BUCKET = 'items';
const DATA = `/api/bucket/${BUCKET}`;
const ITEMS = [
  { name: 'pear', rank: 9 },
  { name: 'Apple', rank: 100 },
  { name: 'cherry', rank: 10 },
  { name: 'banana', rank: 1 },
  { name: 'date', rank: 55 },
];

async function get(api: Api, query: string) {
  return api.post(`${DATA}/get?${query}`, { data: {}, expectStatus: 200 });
}

const names = (response: any): string[] => response.body.data.map((row: any) => row.properties.name);

test.describe('Paging and sorting', () => {
  let robot: Api;

  test.beforeEach(async ({ project }) => {
    await project.createBucket(BUCKET);
    robot = await project.as('robot');
    const quiet = await project.quietly('robot');
    await quiet.post(`${DATA}/multi`, { data: ITEMS.map(properties => ({ properties })), expectStatus: 201 });
  });

  test('pages through the rows by id, with the total and the number of pages', async () => {
    const first = await get(robot, 'limit=2&page=1');
    const second = await get(robot, 'limit=2&page=2');
    const last = await get(robot, 'limit=2&page=3');

    expect(names(first)).toEqual(['pear', 'Apple']);
    expect(names(second)).toEqual(['cherry', 'banana']);
    expect(names(last)).toEqual(['date']);
    expect(first.body).toMatchObject({ total: 5, totalPages: 3, page: 1, limit: 2 });
  });

  test('without a limit returns one row, and a page after the last is empty', async () => {
    const one = await get(robot, '');
    const beyond = await get(robot, 'limit=2&page=9');

    expect(one.body.data).toHaveLength(1);
    expect(one.body.total).toBe(5);
    expect(beyond.body.data ?? []).toEqual([]);
  });

  test('sorts by id descending', async () => {
    expect(names(await get(robot, 'limit=10&sort=desc(id)'))).toEqual(['date', 'banana', 'cherry', 'Apple', 'pear']);
  });

  test('sorts numbers as numbers, not as texts', async () => {
    const response = await get(robot, `limit=10&sort=${encodeURIComponent('desc($.rank)')}`);

    expect(response.body.data.map((row: any) => row.properties.rank)).toEqual([100, 55, 10, 9, 1]);
  });

  test('sorts texts by a property', async () => {
    const response = await get(robot, `limit=10&sort=${encodeURIComponent('asc($.name)')}`);
    const sorted = names(response);

    // whatever the collation does with upper case, the lower-case names are in order
    expect(sorted.filter(name => name !== 'Apple')).toEqual(['banana', 'cherry', 'date', 'pear']);
    expect(sorted).toHaveLength(5);
  });

  test('random order returns every row once', async () => {
    const response = await get(robot, 'limit=10&sort=random');

    expect(names(response).sort()).toEqual(ITEMS.map(item => item.name).sort());
  });

  test('count=false leaves out the total', async () => {
    const response = await get(robot, 'limit=2&count=false');

    expect(names(response)).toEqual(['pear', 'Apple']);
    expect(response.body.total).toBeUndefined();
    expect(response.body.totalPages).toBeUndefined();
  });

  test('an unknown sort field is refused', async () => {
    const response = await robot.post(`${DATA}/get?sort=desc(password)`, { data: {} });

    expect(response.status).toBe(400);
  });
});
