import { cn } from "@/lib/utils"

export function Logo({ className }: { className?: string }) {
  return <img src="/assets/logo.png" alt="" className={cn("size-8 rounded-lg", className)} />
}
