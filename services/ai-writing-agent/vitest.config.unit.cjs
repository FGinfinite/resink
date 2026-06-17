const path = require('path')

module.exports = {
  test: {
    include: ['test/unit/js/**/*.test.js'],
    globals: true,
    setupFiles: [path.join(__dirname, 'test/unit/setup.js')],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['app/js/**/*.js'],
      exclude: ['app/js/mongodb.js'],
    },
  },
}
