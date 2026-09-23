import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const handler = async (request: Request): Promise<Response> => {
	const id = new URL(request.url).searchParams.get("id");
	if (!id) {
		return Response.json({ error: "Pass an email id as ?id=..." }, { status: 400 });
	}

	const { data, error } = await resend.emails.get(id);

	if (error) {
		return Response.json({ error }, { status: 500 });
	}

	return Response.json({ data });
};

export default { fetch: handler };
