import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type AnchorHTMLAttributes,
  type ReactNode
} from "react";

const UNSAVED_MARKDOWN_MESSAGE = "You have unsaved Markdown changes. Leave edit mode?";

type NavigateOptions = {
  guard?: boolean;
  replace?: boolean;
};

type WikiNavigationContextValue = {
  navigate: (href: string, options?: NavigateOptions) => boolean;
  setDirty: (dirty: boolean) => void;
};

const WikiNavigationContext = createContext<WikiNavigationContextValue | null>(null);

export function WikiNavigationProvider({ children }: { children: ReactNode }) {
  const dirty = useRef(false);
  const bypass = useRef(false);
  const routerNavigate = useNavigate();

  useBlocker({
    shouldBlockFn: () => dirty.current && !bypass.current && !window.confirm(UNSAVED_MARKDOWN_MESSAGE),
    enableBeforeUnload: () => dirty.current
  });

  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  const navigate = useCallback((href: string, options: NavigateOptions = {}) => {
    if (options.guard === false) bypass.current = true;
    void routerNavigate({ to: href, replace: options.replace }).finally(() => {
      bypass.current = false;
    });
    return true;
  }, [routerNavigate]);

  const value = useMemo(() => ({ navigate, setDirty }), [navigate, setDirty]);
  return <WikiNavigationContext.Provider value={value}>{children}</WikiNavigationContext.Provider>;
}

export function useWikiNavigation() {
  const value = useContext(WikiNavigationContext);
  if (!value) throw new Error("useWikiNavigation must be used within WikiNavigationProvider");
  return value;
}

export function WikiNavigationLink({ href, children, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string }) {
  if (/^(?:[a-z]+:)?\/\//i.test(href)) return <a href={href} {...props}>{children}</a>;
  return <Link to={href as never} {...props}>{children}</Link>;
}
