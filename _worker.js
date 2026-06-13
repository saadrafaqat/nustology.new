// worker.js - Cloudflare Worker Backend
// Deploy this to Cloudflare Workers with KV namespace bound as "NUST_DB"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const ADMIN_PASSWORD = 'NUSTADMIN2026'; // Change this!

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

async function verifyAdmin(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  return token === ADMIN_PASSWORD;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ─── ADMIN AUTH ───────────────────────────────────────────────
    if (path === '/api/admin/login' && request.method === 'POST') {
      const body = await request.json();
      if (body.password === ADMIN_PASSWORD) {
        return json({ success: true, token: ADMIN_PASSWORD });
      }
      return err('Invalid admin password', 401);
    }

    // ─── STUDENT AUTH ─────────────────────────────────────────────
    if (path === '/api/student/login' && request.method === 'POST') {
      const body = await request.json();
      const { username, password } = body;
      if (!username || !password) return err('Missing credentials');

      const raw = await env.NUST_DB.get(`student:${username.toLowerCase()}`);
      if (!raw) return err('Student not found', 404);

      const student = JSON.parse(raw);
      if (student.password !== password) return err('Invalid password', 401);
      if (!student.active) return err('Account disabled', 403);

      // Return student data (without password)
      const { password: _, ...safeStudent } = student;
      return json({ success: true, student: safeStudent });
    }

    // ─── ADMIN: LIST ALL STUDENTS ─────────────────────────────────
    if (path === '/api/admin/students' && request.method === 'GET') {
      if (!await verifyAdmin(request)) return err('Unauthorized', 401);

      const list = await env.NUST_DB.list({ prefix: 'student:' });
      const students = [];
      for (const key of list.keys) {
        const raw = await env.NUST_DB.get(key.name);
        if (raw) {
          const s = JSON.parse(raw);
          const { password: _, ...safe } = s;
          students.push(safe);
        }
      }
      return json({ students });
    }

    // ─── ADMIN: ADD STUDENT ───────────────────────────────────────
    if (path === '/api/admin/students' && request.method === 'POST') {
      if (!await verifyAdmin(request)) return err('Unauthorized', 401);

      const body = await request.json();
      const { username, password, name, email } = body;
      if (!username || !password) return err('Username and password required');

      const key = `student:${username.toLowerCase()}`;
      const existing = await env.NUST_DB.get(key);
      if (existing) return err('Student already exists');

      const student = {
        username: username.toLowerCase(),
        password,
        name: name || username,
        email: email || '',
        active: true,
        createdAt: new Date().toISOString(),
        bioDataSubmitted: false,
        bioData: null,
      };

      await env.NUST_DB.put(key, JSON.stringify(student));
      const { password: _, ...safe } = student;
      return json({ success: true, student: safe });
    }

    // ─── ADMIN: UPDATE STUDENT ────────────────────────────────────
    if (path.startsWith('/api/admin/students/') && request.method === 'PUT') {
      if (!await verifyAdmin(request)) return err('Unauthorized', 401);

      const username = decodeURIComponent(path.split('/')[4]);
      const key = `student:${username.toLowerCase()}`;
      const raw = await env.NUST_DB.get(key);
      if (!raw) return err('Student not found', 404);

      const student = JSON.parse(raw);
      const body = await request.json();

      // Allowed fields to update
      const allowed = ['name', 'email', 'password', 'active'];
      for (const f of allowed) {
        if (body[f] !== undefined) student[f] = body[f];
      }

      await env.NUST_DB.put(key, JSON.stringify(student));
      const { password: _, ...safe } = student;
      return json({ success: true, student: safe });
    }

    // ─── ADMIN: DELETE STUDENT ────────────────────────────────────
    if (path.startsWith('/api/admin/students/') && request.method === 'DELETE') {
      if (!await verifyAdmin(request)) return err('Unauthorized', 401);

      const username = decodeURIComponent(path.split('/')[4]);
      const key = `student:${username.toLowerCase()}`;
      const raw = await env.NUST_DB.get(key);
      if (!raw) return err('Student not found', 404);

      await env.NUST_DB.delete(key);

      // Also delete all test records
      const tests = await env.NUST_DB.list({ prefix: `tests:${username.toLowerCase()}:` });
      for (const k of tests.keys) await env.NUST_DB.delete(k.name);

      return json({ success: true });
    }

    // ─── STUDENT: SUBMIT BIO DATA ─────────────────────────────────
    if (path === '/api/student/biodata' && request.method === 'POST') {
      const body = await request.json();
      const { username, bioData } = body;
      if (!username) return err('Missing username');

      const key = `student:${username.toLowerCase()}`;
      const raw = await env.NUST_DB.get(key);
      if (!raw) return err('Student not found', 404);

      const student = JSON.parse(raw);
      student.bioData = { ...bioData, submittedAt: new Date().toISOString() };
      student.bioDataSubmitted = true;

      await env.NUST_DB.put(key, JSON.stringify(student));
      return json({ success: true });
    }

    // ─── STUDENT/ADMIN: GET BIO DATA ──────────────────────────────
    if (path.startsWith('/api/student/biodata/') && request.method === 'GET') {
      const username = decodeURIComponent(path.split('/')[4]);
      const key = `student:${username.toLowerCase()}`;
      const raw = await env.NUST_DB.get(key);
      if (!raw) return err('Not found', 404);

      const student = JSON.parse(raw);
      return json({ bioData: student.bioData, submitted: student.bioDataSubmitted });
    }

    // ─── STUDENT: SAVE TEST RESULT ────────────────────────────────
    if (path === '/api/tests' && request.method === 'POST') {
      const body = await request.json();
      const { username, result } = body;
      if (!username || !result) return err('Missing data');

      const testId = `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      const key = `tests:${username.toLowerCase()}:${testId}`;

      const record = {
        testId,
        username: username.toLowerCase(),
        ...result,
        savedAt: new Date().toISOString(),
      };

      await env.NUST_DB.put(key, JSON.stringify(record));
      return json({ success: true, testId });
    }

    // ─── STUDENT: GET MY TESTS ────────────────────────────────────
    if (path.startsWith('/api/tests/') && request.method === 'GET') {
      const username = decodeURIComponent(path.split('/')[3]);
      const list = await env.NUST_DB.list({ prefix: `tests:${username.toLowerCase()}:` });

      const tests = [];
      for (const k of list.keys) {
        const raw = await env.NUST_DB.get(k.name);
        if (raw) {
          const t = JSON.parse(raw);
          // Return summary (exclude full review log for list view)
          const { reviewLog, ...summary } = t;
          tests.push(summary);
        }
      }

      tests.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      return json({ tests });
    }

    // ─── ADMIN: GET ALL TESTS ─────────────────────────────────────
    if (path === '/api/admin/tests' && request.method === 'GET') {
      if (!await verifyAdmin(request)) return err('Unauthorized', 401);

      const list = await env.NUST_DB.list({ prefix: 'tests:' });
      const tests = [];
      for (const k of list.keys) {
        const raw = await env.NUST_DB.get(k.name);
        if (raw) {
          const t = JSON.parse(raw);
          const { reviewLog, ...summary } = t;
          tests.push(summary);
        }
      }
      tests.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      return json({ tests });
    }

    // ─── GET SINGLE TEST (with full review) ───────────────────────
    if (path.startsWith('/api/test/') && request.method === 'GET') {
      const parts = path.split('/');
      const username = decodeURIComponent(parts[3]);
      const testId = decodeURIComponent(parts[4]);

      // Admin check or same student
      const isAdmin = await verifyAdmin(request);
      const key = `tests:${username.toLowerCase()}:${testId}`;
      const raw = await env.NUST_DB.get(key);
      if (!raw) return err('Test not found', 404);

      return json(JSON.parse(raw));
    }

    return err('Not found', 404);
  },
};
