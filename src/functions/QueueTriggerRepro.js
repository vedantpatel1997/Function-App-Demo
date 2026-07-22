const { app } = require('@azure/functions');

app.storageQueue('QueueTriggerRepro', {
    queueName: 'smb-repro-queue',
    connection: 'AzureWebJobsStorage',
    handler: (queueItem, context) => {
        const processedAt = new Date().toISOString();
        const metadata = context.triggerMetadata ?? {};
        const dequeueCount = metadata.dequeueCount ?? metadata.DequeueCount ?? 'n/a';
        const insertionTime = metadata.insertionTime ?? metadata.InsertionTime ?? 'n/a';
        const messageId = metadata.id ?? metadata.Id ?? 'n/a';

        context.log(`QueueTriggerRepro:START | invocationId=${context.invocationId} | messageId=${messageId} | dequeueCount=${dequeueCount}`);
        context.log(`QueueTriggerRepro:PROCESSED | invocationId=${context.invocationId} | messageId=${messageId} | content="${queueItem}" | processedAt=${processedAt} | insertionTime=${insertionTime} | dequeueCount=${dequeueCount}`);
        context.log(`QueueTriggerRepro:METADATA | invocationId=${context.invocationId} | triggerMetadata=${JSON.stringify(metadata)}`);
    }
});
