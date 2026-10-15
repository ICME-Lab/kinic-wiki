import { useCallback, useLayoutEffect, useMemo } from "react";

// Async work may still populate its own cache after navigation, but must not
// replace the visible state of a different request or an unmounted reader.
export function useRequestScope(requestKey: string): () => boolean {
  const scope = useMemo(() => ({ requestKey, active: false }), [requestKey]);
  useLayoutEffect(() => {
    scope.active = true;
    return () => { scope.active = false; };
  }, [scope]);
  return useCallback(() => scope.active, [scope]);
}
