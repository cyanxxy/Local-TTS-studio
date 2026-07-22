import { SynthesisApp } from "../../shared/SynthesisApp";
import Supertonic3Worker from "../../workers/supertonic3.worker?worker";

function createSupertonic3Worker(): Worker {
  return new Supertonic3Worker();
}

export default function DesktopApp() {
  return (
    <SynthesisApp
      enableDesktopRuntimes
      routeBasePath="/desktop"
      createSupertonic3Worker={createSupertonic3Worker}
    />
  );
}
