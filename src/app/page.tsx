import { Suspense } from "react";
import VelvarrApp from "../components/VelvarrApp";
import Loading from "./loading";

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <VelvarrApp />
    </Suspense>
  );
}
