import { test, expect } from '../../fixtures';
import { API_V2, type Api } from '../../support/api';

// The MCP server for AI agents (/mcp, stateless streamable HTTP): JSON-RPC calls with the user's token.
const BUCKET = 'accounts';
const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };

interface ToolResult {
  isError: boolean;
  /** The tool's answer: JSON parsed, or the message of an error. */
  value: any;
}

async function rpc(api: Api, method: string, params: object = {}, name?: string) {
  const response = await api.post('/mcp', {
    headers: MCP_HEADERS,
    data: { jsonrpc: '2.0', id: 1, method, params },
    expectStatus: 200,
    name,
  });
  return response.body;
}

async function callTool(api: Api, tool: string, args: object = {}): Promise<ToolResult> {
  const body = await rpc(api, 'tools/call', { name: tool, arguments: args }, `MCP ${tool}`);
  const text: string = body.result.content[0].text;
  const isError = body.result.isError === true;
  return { isError, value: isError ? text : JSON.parse(text) };
}

test.describe('MCP server', () => {
  test.beforeEach(async ({ project }) => {
    await project.createBucket(BUCKET, { history: true });
  });

  test('introduces itself and lists its tools', async ({ project }) => {
    const agent = await project.as('agent');

    const init = await rpc(agent, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    });
    expect(init.result.serverInfo.name).toBe('databucket');
    expect(init.result.instructions).toContain('list_buckets');

    const tools = await rpc(agent, 'tools/list');
    expect(tools.result.tools.map((tool: any) => tool.name).sort()).toEqual([
      'create_bucket', 'delete_data', 'describe_bucket', 'find_data', 'generate_data', 'get_data', 'insert_data', 'list_buckets',
      'release_data', 'reserve_data', 'search_history', 'update_data',
    ]);
  });

  test('needs a token', async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    const response = await request.post('/mcp', {
      headers: { ...MCP_HEADERS, 'Content-Type': 'application/json' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.status()).toBe(401);
    await request.dispose();
  });

  test('an agent finds, reserves, changes and releases data', async ({ project }) => {
    const agent = await project.as('agent');

    const buckets = await callTool(agent, 'list_buckets');
    expect(buckets.value.map((bucket: any) => bucket.name)).toContain(BUCKET);

    const inserted = await callTool(agent, 'insert_data', {
      bucket: BUCKET,
      rows: [
        { properties: { login: 'alice', status: 'active' } },
        { properties: { login: 'bob', status: 'active' } },
        { properties: { login: 'carol', status: 'blocked' } },
      ],
    });
    expect(inserted.isError).toBe(false);
    expect(inserted.value).toHaveLength(3);

    const active = await callTool(agent, 'find_data', { bucket: BUCKET, rules: [['$.status', '==', 'active']], sort: 'asc($.login)' });
    expect(active.value.total).toBe(2);
    expect(active.value.data.map((row: any) => row.properties.login)).toEqual(['alice', 'bob']);

    const reserved = await callTool(agent, 'reserve_data', { bucket: BUCKET, rules: [['$.status', '==', 'active']] });
    expect(reserved.value).toMatchObject({ reserved: 1, available: 1 });
    const row = reserved.value.data[0];
    expect(row.owner).toBe(project.users.agent.username);

    const updated = await callTool(agent, 'update_data', { bucket: BUCKET, ids: [row.id], propertiesToSet: { '$.status': 'used' } });
    expect(updated.value.count).toBe(1);

    const released = await callTool(agent, 'release_data', { bucket: BUCKET, ids: [row.id] });
    expect(released.value.count).toBe(1);

    const history = await callTool(agent, 'search_history', { bucket: BUCKET, rules: [['id', '==', row.id]], properties: true });
    // inserted, reserved, changed, released
    expect(history.value.total).toBe(4);
    expect(history.value.history.every((entry: any) => entry.modifiedBy === project.users.agent.username)).toBe(true);
  });

  test('an agent can not remove data, a robot can', async ({ project }) => {
    const agent = await project.as('agent');
    const robot = await project.as('robot');
    const row = await robot.post(`/api/bucket/${BUCKET}`, { headers: API_V2, data: { properties: { login: 'dave' } }, expectStatus: 201 });

    const byAgent = await callTool(agent, 'delete_data', { bucket: BUCKET, ids: [row.body.id] });
    expect(byAgent.isError).toBe(true);
    expect(byAgent.value).toContain('ROBOT role');
    // the REST API refuses it too
    await agent.delete(`/api/bucket/${BUCKET}/${row.body.id}`, { headers: API_V2, expectStatus: 403 });

    const byRobot = await callTool(robot, 'delete_data', { bucket: BUCKET, ids: [row.body.id] });
    expect(byRobot.value.count).toBe(1);
  });

  test('an agent inserts free rows into a bucket with protected data', async ({ project }) => {
    await project.createBucket('secrets', { protectedData: true });
    const agent = await project.as('agent');

    const inserted = await callTool(agent, 'insert_data', {
      bucket: 'secrets',
      rows: [{ properties: { login: 'free' } }, { properties: { login: 'mine' }, reserved: true }],
    });
    expect(inserted.isError).toBe(false);
    expect(inserted.value.map((row: any) => [row.properties.login, row.reserved])).toEqual([['free', false], ['mine', true]]);

    // afterwards the agent sees only its own row
    const found = await callTool(agent, 'find_data', { bucket: 'secrets' });
    expect(found.value.data.map((row: any) => row.properties.login)).toEqual(['mine']);
  });

  test('an agent generates many rows from a generator per property', async ({ project }) => {
    const agent = await project.as('agent');
    const fields = {
      '$.login': 'user-{n}',
      '$.name': '#{Name.fullName}',
      '$.address.city': '#{Address.city}',
      '$.age': { number: [18, 90] },
      '$.status': { oneOf: ['active', 'blocked'], weights: [9, 1] },
      '$.since': { date: ['2024-01-01', '2024-12-31'] },
      '$.type': 'customer',
    };

    const first = await callTool(agent, 'generate_data', { bucket: BUCKET, fields, count: 1000, locale: 'pl', seed: 1 });
    expect(first.isError).toBe(false);
    expect(first.value).toMatchObject({ inserted: 1000, firstN: 1, lastN: 1000 });
    expect(first.value.sample).toHaveLength(3);
    const row = first.value.sample[0];
    expect(row).toMatchObject({ login: 'user-1', type: 'customer', address: { city: expect.any(String) } });
    expect(row.age).toBeGreaterThanOrEqual(18);
    expect(row.since).toMatch(/^2024-\d\d-\d\d$/);

    // the next call continues {n} after the last id, so the logins stay unique
    const second = await callTool(agent, 'generate_data', { bucket: BUCKET, fields, count: 10 });
    expect(second.value).toMatchObject({ inserted: 10, firstN: 1001, lastN: 1010 });

    const all = await callTool(agent, 'find_data', { bucket: BUCKET, limit: 0 });
    expect(all.value.total).toBe(1010);
    const found = await callTool(agent, 'find_data', { bucket: BUCKET, rules: [['$.login', '==', 'user-1010']] });
    expect(found.value.total).toBe(1);
    expect(found.value.data[0].createdBy).toBe(project.users.agent.username);
  });

  test('an admin creates a bucket from an example row, an agent fills it', async ({ project }) => {
    const admin = await project.as('admin');
    const created = await callTool(admin, 'create_bucket', {
      name: 'customers',
      description: 'Customers for the checkout tests',
      sample: { login: 'anna', age: 34, active: true, birthDate: '1990-05-01', address: { city: 'Paris' }, roles: ['x'] },
      fields: [{ path: '$.status', type: 'enum', values: ['active', 'blocked'] }],
      indexedProperties: [{ path: '$.login', type: 'text' }],
    });
    expect(created.isError).toBe(false);
    expect(created.value.bucket).toMatchObject({ name: 'customers', history: true, protectedData: false, dataClass: 'customers' });
    expect(created.value.bucket.fields).toEqual([
      { title: 'Login', path: '$.login', type: 'string' },
      { title: 'Age', path: '$.age', type: 'numeric' },
      { title: 'Active', path: '$.active', type: 'boolean' },
      { title: 'Birth date', path: '$.birthDate', type: 'date' },
      { title: 'City', path: '$.address.city', type: 'string' },
      { title: 'Status', path: '$.status', type: 'select', values: ['active', 'blocked'] },
    ]);
    expect(created.value.bucket.indexedProperties).toEqual([{ path: '$.login', type: 'text' }]);
    expect(created.value).toMatchObject({ view: 'customers', enums: ['customers Status'] });
    expect(created.value.skipped[0]).toContain('$.roles');

    // the view shows the bucket in the web application (members and up)
    const member = await project.quietly('member');
    const tree = await member.get('/api/session/access-tree', { expectStatus: 200 });
    expect(tree.body.buckets.map((bucket: any) => bucket.name)).toContain('customers');
    expect(tree.body.views.map((view: any) => view.name)).toContain('customers');

    // everyone in the project, also an agent, can use it
    const agent = await project.as('agent');
    const generated = await callTool(agent, 'generate_data', {
      bucket: 'customers',
      count: 50,
      fields: { '$.login': 'c-{n}', '$.status': { oneOf: ['active', 'blocked'] }, '$.address.city': '#{Address.city}' },
    });
    expect(generated.value.inserted).toBe(50);
    const found = await callTool(agent, 'find_data', { bucket: 'customers', rules: [['$.login', '==', 'c-7']] });
    expect(found.value.total).toBe(1);

    // the name is taken now; an agent can't create buckets
    const again = await callTool(admin, 'create_bucket', { name: 'customers', sample: { a: 1 } });
    expect(again).toEqual({ isError: true, value: expect.stringContaining('already exists') });
    const byAgent = await callTool(agent, 'create_bucket', { name: 'mine', sample: { a: 1 } });
    expect(byAgent).toEqual({ isError: true, value: expect.stringContaining('needs the ADMIN role') });
  });

  test('explains mistakes to the agent', async ({ project }) => {
    const agent = await project.as('agent');

    const unknownBucket = await callTool(agent, 'find_data', { bucket: 'no-such-bucket' });
    expect(unknownBucket).toEqual({ isError: true, value: expect.stringContaining('list_buckets') });

    const sqlRule = await callTool(agent, 'find_data', { bucket: BUCKET, rules: ["properties->>'a' = '1'"] });
    expect(sqlRule).toEqual({ isError: true, value: expect.stringContaining('[left, operator, right]') });

    const unknownTag = await callTool(agent, 'insert_data', { bucket: BUCKET, rows: [{ properties: { a: 1 }, tagId: 999999 }] });
    expect(unknownTag).toEqual({ isError: true, value: expect.stringContaining('describe_bucket') });

    const badGenerator = await callTool(agent, 'generate_data', { bucket: BUCKET, count: 10, fields: { '$.age': { number: [9, 1] } } });
    expect(badGenerator).toEqual({ isError: true, value: expect.stringContaining("'$.age': min is greater than max") });

    const badExpression = await callTool(agent, 'generate_data', { bucket: BUCKET, count: 10, fields: { '$.x': '#{NoSuch.thing}' } });
    expect(badExpression).toEqual({ isError: true, value: expect.stringContaining("Field '$.x'") });

    const tooMany = await callTool(agent, 'generate_data', { bucket: BUCKET, count: 10001, fields: { '$.a': 1 } });
    expect(tooMany).toEqual({ isError: true, value: expect.stringContaining('1..10000') });

    const nothing = await callTool(agent, 'find_data', { bucket: BUCKET, limit: 0 });
    expect(nothing.value.total).toBe(0);
  });
});
