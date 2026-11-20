import { test, expect } from '../../fixtures';
import { Api } from '../../support/api';
import { ROLE } from '../../support/env';
import { TestProject } from '../../support/project';

test.describe('Projects are separate', () => {
  test('a bucket of another project does not exist for the user', async ({ project, playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    const other = await TestProject.create(request);
    try {
      await other.createBucket('secret-orders');
      const otherRobot = await other.quietly('robot');
      await otherRobot.post('/api/bucket/secret-orders', { data: { properties: { card: '4111' } }, expectStatus: 201 });

      const robot = await project.as('robot');
      const search = await robot.post('/api/bucket/secret-orders/get', { data: {} });
      const insert = await robot.post('/api/bucket/secret-orders', { data: { properties: { x: 1 } } });

      expect(search.status).toBe(404);
      expect(insert.status).toBe(404);
    } finally {
      await other.dispose();
      await request.dispose();
    }
  });

  test('the same bucket name in two projects means two separate buckets', async ({ project, playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    const other = await TestProject.create(request);
    try {
      await project.createBucket('orders');
      await other.createBucket('orders');
      const otherRobot = await other.quietly('robot');
      const theirs = await otherRobot.post('/api/bucket/orders', { data: { properties: { owner: 'other project' } }, expectStatus: 201 });

      const robot = await project.as('robot');
      const ours = await robot.post('/api/bucket/orders/get?limit=10', { data: {}, expectStatus: 200 });
      const byTheirId = await robot.get(`/api/bucket/orders/${theirs.body.id}`, { expectStatus: 200 });

      expect(ours.body.total).toBe(0);
      expect(byTheirId.body).toEqual([]);
    } finally {
      await other.dispose();
      await request.dispose();
    }
  });

  test('the settings list only the objects of the own project', async ({ project, playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    const other = await TestProject.create(request);
    try {
      await other.createBucket('their-bucket');
      await project.createBucket('our-bucket');

      const admin = await project.as('admin');
      const buckets = await admin.get('/api/buckets', { expectStatus: 200 });

      expect(buckets.body.map((bucket: any) => bucket.name)).toEqual(['our-bucket']);
    } finally {
      await other.dispose();
      await request.dispose();
    }
  });

  test('a user can not sign in to a project they are not assigned to', async ({ project, playwright, baseURL, request }) => {
    const otherRequest = await playwright.request.newContext({ baseURL });
    const other = await TestProject.create(otherRequest);
    try {
      const anonymous = new Api(request, 'anonymous');
      const user = project.users.member;

      const response = await anonymous.post('/api/public/signin', {
        data: { username: user.username, password: user.password, projectId: other.id },
      });

      expect(response.body.token).toBeUndefined();
      expect(response.status).not.toBe(200);
    } finally {
      await other.dispose();
      await otherRequest.dispose();
    }
  });
});

test.describe('Access to buckets', () => {
  test('a bucket for ADMIN and up is hidden from a MEMBER', async ({ project }) => {
    const admin = await project.quietly('admin');
    await admin.post('/api/buckets', { data: { name: 'admins-only', icon: { name: 'Storage' }, roleId: ROLE.ADMIN }, expectStatus: 201 });
    const member = await project.as('member');

    const response = await member.post('/api/bucket/admins-only/get', { data: {} });
    const tree = await member.get('/api/session/access-tree', { expectStatus: 200 });

    expect(response.status).toBe(404);
    expect(tree.body.buckets.map((bucket: any) => bucket.name)).not.toContain('admins-only');
  });

  test('a bucket for ROBOT and up is hidden from an AGENT', async ({ project }) => {
    const admin = await project.quietly('admin');
    await admin.post('/api/buckets', { data: { name: 'robots', icon: { name: 'Storage' }, roleId: ROLE.ROBOT }, expectStatus: 201 });

    const agent = await project.as('agent');
    const robot = await project.as('robot');

    expect((await agent.post('/api/bucket/robots/get', { data: {} })).status).toBe(404);
    expect((await robot.post('/api/bucket/robots/get', { data: {} })).status).toBe(200);
  });

  test('a bucket given to chosen users only', async ({ project }) => {
    const admin = await project.quietly('admin');
    const users = await admin.get('/api/users', { expectStatus: 200 });
    const robotId = users.body.find((user: any) => user.username === project.users.robot.username).id;
    await admin.post('/api/buckets', { data: { name: 'robot-only', icon: { name: 'Storage' }, usersIds: [robotId] }, expectStatus: 201 });

    const robot = await project.as('robot');
    const member = await project.as('member');

    expect((await robot.post('/api/bucket/robot-only/get', { data: {} })).status).toBe(200);
    expect((await member.post('/api/bucket/robot-only/get', { data: {} })).status).toBe(404);
  });
});

test.describe('Roles', () => {
  test('ROBOT and AGENT can not use the web application endpoints', async ({ project }) => {
    const robot = await project.as('robot');
    const agent = await project.as('agent');

    expect((await robot.get('/api/session/access-tree')).status).toBe(403);
    expect((await agent.get('/api/session/access-tree')).status).toBe(403);
    expect((await robot.get('/api/users')).status).toBe(403);
  });

  test('a MEMBER can not change the settings of the project', async ({ project }) => {
    const member = await project.as('member');

    expect((await member.post('/api/tags', { data: { name: 'x' } })).status).toBe(403);
    expect((await member.post('/api/classes', { data: { name: 'x' } })).status).toBe(403);
    expect((await member.post('/api/enums', { data: { name: 'x', items: [] } })).status).toBe(403);
    expect((await member.post('/api/views', { data: { name: 'x', columnsId: 1 } })).status).toBe(403);
  });

  test('only a SUPER user manages projects and users', async ({ project }) => {
    const admin = await project.as('admin');

    expect((await admin.get('/api/manage/projects')).status).toBe(403);
    expect((await admin.get('/api/manage/users')).status).toBe(403);
    expect((await admin.post('/api/manage/projects', { data: { name: 'mine', enabled: true } })).status).toBe(403);
  });

  test('a token that is broken or made up is refused', async ({ project, request }) => {
    const valid = await project.token('robot');
    const tampered = valid.slice(0, -4) + (valid.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'super', 'a-key': 'ROLE_SUPER', 'p-id': project.id })).toString('base64url');

    for (const token of [tampered, `${header}.${payload}.`, 'not-a-token']) {
      const response = await new Api(request, 'anonymous', token).post('/api/bucket/any/get', { data: {} });
      expect(response.status).toBe(401);
    }
  });
});
