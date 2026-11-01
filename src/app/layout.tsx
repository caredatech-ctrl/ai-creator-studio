import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AI Creator Studio",
  description: "Analyze, optimize, and prepare your videos for YouTube with AI."
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}