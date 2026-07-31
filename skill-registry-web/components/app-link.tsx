import { Link, type LinkProps } from "@tanstack/react-router";
import type { AnchorHTMLAttributes } from "react";

export function AppLink({ href, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string }) {
  return <Link to={href as LinkProps["to"]} {...props} />;
}
