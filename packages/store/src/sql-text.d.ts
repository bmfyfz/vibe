// A migration imported `with { type: "text" }` is its SQL, as a string.
declare module "*.sql" {
  const text: string;
  export default text;
}
