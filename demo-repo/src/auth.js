function login(user) {
  if (!user) throw new Error('user required');
  return { user, token: `t-${user}` };
}

const invalidated = new Set();

function session(token) {
  if (invalidated.has(token)) return false;
  return typeof token === 'string' && token.startsWith('t-');
}

function logout(token) {
  invalidated.add(token);
  return true;
}

module.exports = { login, session, logout };
