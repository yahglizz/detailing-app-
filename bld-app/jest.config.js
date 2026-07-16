module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src', '<rootDir>/__tests__', '<rootDir>/../supabase/functions/_shared'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  // _shared sources live outside the app root; resolve babel helpers from here
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
};
