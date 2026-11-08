"use client";

import { useEffect, useState } from "react";
import type { z } from "zod";
import { api, ApiFailure } from "./client-api";

export function useResource<T>(path: string, schema: z.ZodType<T>, interval = 0) {
  const [state, setState] = useState<{ path: string; data: T | null; error: string; busy: boolean; authDenied: boolean }>({ path: "", data: null, error: "", busy: true, authDenied: false });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true, sequence = 0;
    async function load() {
      const request = ++sequence;
      setState((old) => ({ path, data: old.path === path ? old.data : null, error: old.path === path ? old.error : "", busy: true, authDenied: old.path === path && old.authDenied }));
      try {
        const data = await api(path, schema);
        if (active && sequence === request) setState({ path, data, error: "", busy: false, authDenied: false });
      } catch (error) {
        // 権限が失効したときは古い名簿を残さず、通信失敗による未更新とは区別する。
        const authDenied = error instanceof ApiFailure && (error.status === 401 || error.status === 403);
        if (active && sequence === request) setState((old) => ({ ...old, data: authDenied ? null : old.data, path, authDenied, error: error instanceof Error ? error.message : "情報を取得できませんでした。", busy: false }));
      }
    }
    // 画面を離れた後や古い検索の応答で、新しい画面の結果を上書きしない。
    void Promise.resolve().then(() => { if (active) void load(); });
    const timer = interval ? window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, interval) : undefined;
    return () => { active = false; if (timer) window.clearInterval(timer); };
  }, [path, schema, interval, generation]);
  return { data: state.path === path ? state.data : null, error: state.path === path ? state.error : "", authDenied: state.path === path && state.authDenied, loading: state.path !== path || state.busy,
    refresh: () => setGeneration((value) => value + 1) };
}
