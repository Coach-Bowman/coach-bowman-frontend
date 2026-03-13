export async function get({ request }) {
  const apiUrl = import.meta.env.PUBLIC_API_KEY;
  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return new Response(`Error: ${response.statusText}`, {
        status: response.status,
      });
    }
    let users = [];
    users = await response.json();
    users = users.map((user) => ({
      ...user,
      formattedDate: new Date(user.createdAt)
        .toLocaleString("en-US", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        })
        .replace(",", " at"), // Replace the comma between date and time with "at"
    }));
    return new Response(JSON.stringify(users), { status: 200 });
  } catch (error) {
    return new Response("Failed to fetch users", { status: 500 });
  }
}
