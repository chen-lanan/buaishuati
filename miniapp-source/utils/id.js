function randomPart() {
  return Math.random().toString(36).slice(2, 8);
}

function createId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${randomPart()}`;
}

module.exports = { createId };
