import { Link, type LinkProps } from "@tanstack/react-router";
import type { AnchorHTMLAttributes } from "react";

type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
};

export function AppLink({ href, ...props }: AppLinkProps) {
  return <Link to={href as LinkProps["to"]} {...props} />;
}
