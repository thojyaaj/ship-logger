import PinPad from "./PinPad";

export default function LoginPage() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-6 md:gap-10 p-8 bg-ink text-paper">
      <div className="text-center flex flex-col items-center gap-3">
        <span className="tag-label !text-orange">Freight Operations Terminal</span>
        <h1 className="font-stencil text-5xl tracking-wide">SHIP LOGGER</h1>
        <div className="w-24 barcode h-2 mt-1" style={{ filter: "invert(1)" }} />
        <p className="text-paper/50 mt-3 text-sm data">ENTER 4-DIGIT OPERATOR PIN</p>
      </div>
      <PinPad />
    </main>
  );
}
