import Poe from 'poe-client';

export default async function handler(req, res) {
    // 1. Ensure the request method is POST
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // 2. Extract text from the request body
        const { text } = await req.json();
        if (!text) {
            return res.status(400).json({ error: 'Text is required in the request body.' });
        }

        // 3. Initialize the Poe client with your API key from environment variables
        //    This is crucial for security. The key is never exposed to the frontend.
        const client = new Poe.Client({ apiKey: process.env.POE_API_KEY });
        if (!process.env.POE_API_KEY) {
            throw new Error('Poe API key is not configured.');
        }

        // 4. --- CORE CHANGE ---
        //    Call the specific model using client.chat.completions.create
        //    This gives you precise control over the model being used.
        const completion = await client.chat.completions.create({
            model: "ElevenLabs-v3", // Hardcoded model name as requested
            messages: [{ role: 'user', content: text }],
            stream: true, // We will stream the audio data for a better user experience
        });

        // 5. Set response headers for streaming audio
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
        });

        // 6. Stream the response back to the client
        //    As audio chunks arrive from Poe, we immediately forward them to the browser.
        //    The Poe client library handles parsing the stream.
        for await (const chunk of completion) {
            // The actual audio data is in chunk.choices[0].delta.content
            const audioChunk = chunk.choices[0]?.delta?.content;
            if (audioChunk) {
                res.write(audioChunk);
            }
        }

        // 7. End the response stream once all chunks are sent
        res.end();

    } catch (error) {
        console.error('Poe API Error:', error.message);
        // Ensure we send a JSON error response if something goes wrong
        if (!res.headersSent) {
            res.status(500).json({ error: `Server error: ${error.message}` });
        } else {
            // If headers are already sent, we can't change the status code,
            // but we can end the stream to signal an error.
            res.end();
        }
    }
}