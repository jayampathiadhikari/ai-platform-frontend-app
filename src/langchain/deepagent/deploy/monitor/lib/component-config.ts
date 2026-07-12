import type { ComponentTag } from "@/lib/types";

interface ComponentConfig {
  label: string;
  color: string;        // Tailwind bg class (inline style fallback)
  textColor: string;    // Tailwind text class
  hex: string;          // for inline style
}

export const COMPONENT_CONFIG: Record<string, ComponentConfig> = {
  "deep:orchestrator":    { label: "orchestrator",    color: "bg-purple-900",  textColor: "text-purple-200",  hex: "#581c87" },
  "deep:resolveTicket":   { label: "resolveTicket",   color: "bg-blue-900",    textColor: "text-blue-200",    hex: "#1e3a5f" },
  "deep:setupWorkspace":  { label: "setupWorkspace",  color: "bg-cyan-900",    textColor: "text-cyan-200",    hex: "#164e63" },
  "deep:devAgent":        { label: "devAgent",         color: "bg-green-900",   textColor: "text-green-200",   hex: "#14532d" },
  "deep:reviewAgent":     { label: "reviewAgent",      color: "bg-yellow-900",  textColor: "text-yellow-200",  hex: "#713f12" },
  "deep:postProcess":     { label: "postProcess",      color: "bg-orange-900",  textColor: "text-orange-200",  hex: "#7c2d12" },
  "deep:teardown":        { label: "teardown",         color: "bg-red-950",     textColor: "text-red-300",     hex: "#450a0a" },
  "workspace":            { label: "workspace",        color: "bg-indigo-900",  textColor: "text-indigo-200",  hex: "#312e81" },
  "workspace-helpers":    { label: "ws-helpers",       color: "bg-indigo-800",  textColor: "text-indigo-200",  hex: "#3730a3" },
  "deepagent":            { label: "deepagent",        color: "bg-emerald-900", textColor: "text-emerald-200", hex: "#064e3b" },
  "deepagent:bash":       { label: "bash",             color: "bg-slate-700",   textColor: "text-slate-200",   hex: "#334155" },
  "github":               { label: "github",           color: "bg-pink-900",    textColor: "text-pink-200",    hex: "#500724" },
  "job-registry":         { label: "job-registry",     color: "bg-gray-700",    textColor: "text-gray-200",    hex: "#374151" },
  "executor":             { label: "executor",         color: "bg-red-900",     textColor: "text-red-200",     hex: "#7f1d1d" },
  "server":               { label: "server",           color: "bg-teal-900",    textColor: "text-teal-200",    hex: "#134e4a" },
  "POST /run/deepagent":  { label: "POST /run",        color: "bg-violet-900",  textColor: "text-violet-200",  hex: "#4c1d95" },
};

const FALLBACK: ComponentConfig = {
  label: "",
  color: "bg-zinc-800",
  textColor: "text-zinc-300",
  hex: "#27272a",
};

export function getComponentConfig(tag: ComponentTag | null | string): ComponentConfig {
  if (!tag) return FALLBACK;
  return COMPONENT_CONFIG[tag] ?? { ...FALLBACK, label: tag };
}
