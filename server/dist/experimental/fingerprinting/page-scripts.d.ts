/** Build a read-only IIFE that fingerprints the element matching `selector`, or returns null.
 *  Uses getSelectorExpression (not raw querySelector) so SuperSurf's :has-text extension and
 *  digit-leading-id selectors resolve the same way the real resolver does. */
export declare function captureExpr(selector: string): string;
/** Build a read-only IIFE that scores all candidates against `targetJson`, returns best {cx,cy,score,margin} or null. */
export declare function scoreExpr(targetJson: string): string;
//# sourceMappingURL=page-scripts.d.ts.map