// Fixture for #22 — symbol kinds that v0.1 missed or misclassified.
// Each construct below maps to an assertion in symbol-kinds.test.ts.

class Base {}
interface Greeter {}

export class User extends Base implements Greeter {
  static create(): User {
    return new User();
  }
  get name(): string {
    return 'x';
  }
  set name(v: string) {
    void v;
  }
  greet(): string {
    return 'hi';
  }
}

export namespace Geometry {
  export function area(r: number): number {
    return 3.14 * r * r;
  }
}

function realHandler(): void {}
export const handler: () => void = realHandler;

export const obj = {
  doThing() {
    return 1;
  },
  arrowProp: () => 2,
};

export default function () {
  return 'default';
}
