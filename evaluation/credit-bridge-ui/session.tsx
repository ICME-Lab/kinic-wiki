import { createContext, useContext } from "react";
export const FixtureSession = createContext({});
export const useAppSession = () => useContext(FixtureSession);
