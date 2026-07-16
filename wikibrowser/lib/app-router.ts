import { useLocation, useNavigate } from "@tanstack/react-router";

export function useAppPathname(): string {
  return useLocation({ select: (location) => location.pathname });
}

export function useAppSearchParams(): URLSearchParams {
  const search = useLocation({ select: (location) => location.searchStr });
  return new URLSearchParams(search);
}

export function useAppNavigate() {
  const navigate = useNavigate();
  return {
    push: (href: string) => navigate({ to: href }),
    replace: (href: string) => navigate({ to: href, replace: true })
  };
}
