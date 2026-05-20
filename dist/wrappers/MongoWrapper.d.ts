declare const MongoWrapper: {
    createClient(name: string, uri: string): Promise<import("mongodb").Db>;
    getClient(_name: string): never;
    getDb(name: string): import("mongodb").Db;
    getCollection(dbName: string, collectionName: string): import("mongodb").Collection<import("bson").Document>;
    closeClient(name: string): Promise<void>;
};
export default MongoWrapper;
//# sourceMappingURL=MongoWrapper.d.ts.map