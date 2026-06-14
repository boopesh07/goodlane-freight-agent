import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Goodlane Freight Agent",
  description: "AI intake assistant for freight broker carrier inquiries",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
