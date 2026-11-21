import {configDefaults, defineConfig} from 'vitest/config';

// `npm test` の引数(lib、test/unit)は、パスに含まれる文字列での絞り込みとして働く。.claude/worktrees/ に残った
// 別の作業ツリーのテストまで流さないように、.claude/ を除く(#301)
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
