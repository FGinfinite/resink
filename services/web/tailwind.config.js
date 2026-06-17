/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './node_modules/streamdown/dist/**/*.{js,cjs}',
    '../../node_modules/streamdown/dist/**/*.{js,cjs}',
  ],
  // Overleaf 暗色模式: body[data-theme="default"]
  // 亮色模式: body[data-theme="light"]
  // (见 frontend/js/shared/hooks/use-themed-page.tsx:10)
  darkMode: ['selector', '[data-theme="default"]'],
  // 所有工具类嵌套在 .ai-streamdown-root 下，隔离 Bootstrap 冲突
  important: '.ai-streamdown-root',
  corePlugins: {
    preflight: false, // 不覆盖 Bootstrap 5 的 reboot
  },
  theme: {
    extend: {
      colors: {
        // 映射 Streamdown 需要的 shadcn/ui 语义色到 Overleaf 变量
        // 使用 CSS 变量引用，支持主题切换
        border: 'var(--sd-border)',
        background: 'var(--sd-background)',
        foreground: 'var(--sd-foreground)',
        primary: { DEFAULT: 'var(--sd-primary)' },
        muted: {
          DEFAULT: 'var(--sd-muted)',
          foreground: 'var(--sd-muted-foreground)',
        },
      },
      borderColor: {
        DEFAULT: 'var(--sd-border)',
      },
    },
  },
}
