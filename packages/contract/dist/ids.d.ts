import { z } from 'zod';
export declare const ThreadId: z.ZodString;
export declare const AnswerId: z.ZodString;
export declare const SpaceId: z.ZodString;
export declare const DocId: z.ZodString;
export declare const ArtifactId: z.ZodString;
export declare const RequestId: z.ZodString;
export declare const MemoryId: z.ZodString;
export declare const UserId: z.ZodString;
export type ThreadId = z.infer<typeof ThreadId>;
export type AnswerId = z.infer<typeof AnswerId>;
export type SpaceId = z.infer<typeof SpaceId>;
export type DocId = z.infer<typeof DocId>;
export type ArtifactId = z.infer<typeof ArtifactId>;
/** Short, url-safe, collision-resistant enough for one cohort. `newId('thr')` → `thr_k3f9a2b1c7`. */
export declare function newId(prefix: 'thr' | 'ans' | 'spc' | 'doc' | 'art' | 'req' | 'mem'): string;
//# sourceMappingURL=ids.d.ts.map