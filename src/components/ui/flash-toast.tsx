"use client";

import { useEffect, useRef } from "react";
import { useToast } from "./toast";

type FlashToastProps = {
  title: string;
  description?: string;
  tone?: "info" | "success" | "danger";
};

/** Dispara um toast uma única vez ao montar (ex.: após um redirect). */
export function FlashToast({ title, description, tone = "success" }: FlashToastProps) {
  const { toast } = useToast();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    toast({ title, description, tone });
  }, [toast, title, description, tone]);

  return null;
}
