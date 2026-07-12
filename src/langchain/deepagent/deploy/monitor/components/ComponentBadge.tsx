"use client";

import { getComponentConfig } from "@/lib/component-config";
import type { ComponentTag } from "@/lib/types";

interface ComponentBadgeProps {
  tag: ComponentTag | null | string;
  size?: "sm" | "md";
}

export function ComponentBadge({ tag, size = "sm" }: ComponentBadgeProps) {
  const cfg = getComponentConfig(tag);
  const label = cfg.label || tag || "?";
  const px = size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs";

  return (
    <span
      className={`inline-flex items-center rounded-full font-mono font-semibold tracking-tight leading-none ${px}`}
      style={{ backgroundColor: cfg.hex, color: "#e2e8f0" }}
    >
      {label}
    </span>
  );
}
