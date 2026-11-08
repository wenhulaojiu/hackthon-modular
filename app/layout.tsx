import type { Metadata } from "next";
import "./globals.css";
import "./kexu.css";
import "../页面模块/09-公共工具与样式/components.css";
import "../页面模块/04-微信数据/local-wechat.css";
import "../页面模块/05-自动回复/auto-reply.css";
import "../页面模块/08-数据导出/data-export.css";
import "./green-theme.css";

export const metadata: Metadata = {
  title: "客序 · 商家经营工作台",
  description: "从微信往来到客户洞察，让每一次经营更有方向。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
