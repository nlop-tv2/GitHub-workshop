import { gameModule } from "./game/index";
import { inputModule } from "./input/index";
import { levelsModule } from "./levels/index";
import { renderModule } from "./render/index";

const canvas = document.querySelector<HTMLCanvasElement>("#game");

if (!canvas) {
  throw new Error("The game canvas could not be found.");
}

void [gameModule, inputModule, levelsModule, renderModule];
