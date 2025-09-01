import { UniformController } from './playgroundInterface';

export * from './playgroundInterface';

export function isControllerRendered(controller: UniformController) {
    return controller.type == "SLIDER" || controller.type == "COLOR_PICK";
}