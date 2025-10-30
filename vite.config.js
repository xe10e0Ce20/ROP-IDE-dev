// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  // Vite 默认配置非常适合你的需求
  // 这里唯一的关键是为了部署到像 GitHub Pages 这样的子目录
  base: './', 
  
  // 确保 PyScript 的核心文件能够被正确处理（通常不需要配置）
  build: {
    outDir: 'dist', // 构建输出目录
    assetsInlineLimit: 0 // 防止大文件被内联
  },
  
  optimizeDeps: {
    // 强制 Vite 将这些核心 CodeMirror 模块视为唯一的共享依赖
    include: [
      // 列出所有可能导致问题的核心模块
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/commands',
      '@codemirror/history',
      '@codemirror/autocomplete',
      '@codemirror/lint',
      '@codemirror/theme-one-dark', // 包含主题以确保依赖一致性
      // 确保基础依赖也被包含
      '@lezer/common' 
    ]
  },
  
  // 用于本地开发时代理或启动本地服务器
  server: {
    open: true,
  }
});
// vite.config.js
