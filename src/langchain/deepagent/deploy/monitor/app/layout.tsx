import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "DeepAgent Monitor",
  description: "Real-time log viewer for the DeepAgent pipeline",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${geistMono.variable} font-sans antialiased`}>
        <TooltipProvider>
          {children}
        </TooltipProvider>
      </body>
    </html>
  );
}
