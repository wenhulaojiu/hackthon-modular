import type { Metadata } from "next";
import "./globals.css";
import "./kexu.css";
import "./components/components.css";
import "./components/local-wechat.css";

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
