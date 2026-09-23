import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const handler = async (_request: Request): Promise<Response> => {
	const { data, error } = await resend.batch.send([
		{
			from: "onboarding@resend.dev",
			to: "delivered@resend.dev",
			subject: "hello world",
			html: "<strong>it works!</strong>",
		},
		{
			from: "onboarding@resend.dev",
			to: "delivered@resend.dev",
			subject: "hello again",
			html: "<strong>second message</strong>",
		},
	]);

	if (error) {
		return Response.json({ error }, { status: 500 });
	}

	return Response.json({ data });
};

export default { fetch: handler };
