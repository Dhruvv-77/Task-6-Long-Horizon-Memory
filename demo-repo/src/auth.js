function login(user) {
  if (!user) throw new Error('user required');
  return { user, token: `t-${user}` };
}

function session(token) {
  return typeof token === 'string' && token.startsWith('t-');
}

module.exports = { login, session };
