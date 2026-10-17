"""
Seed Module for TaskPilot Graph.
Resets FalkorDB graph to clean state and populates the synthetic organization,
project, task, and dependency topology with UTC relative deadlines.
"""

from datetime import datetime, timezone, timedelta
from typing import Dict, Any
from app.graph import clear_graph, init_schema_and_indexes, get_graph


def reset_and_seed(graph=None) -> Dict[str, Any]:
    """
    Clears the entire graph, configures indexes, and creates seed entities.
    Deadlines are dynamically computed relative to current UTC date.
    """
    if graph is None:
        graph = get_graph()

    # 1. Clear existing nodes and relationships
    clear_graph(graph)

    # 2. Re-create indexes
    init_schema_and_indexes(graph)

    now_utc = datetime.now(timezone.utc)
    today_str = now_utc.strftime("%Y-%m-%d")

    def offset(days: int) -> str:
        return (now_utc + timedelta(days=days)).strftime("%Y-%m-%d")

    # 3. Create People and REPORTS_TO hierarchy
    # Hierarchy: Rahul, Priya, Aman -> Neha -> Karan
    cypher_people = """
    CREATE (karan:Person {name: 'Karan', email: 'karan@demo.com'})
    CREATE (neha:Person {name: 'Neha', email: 'neha@demo.com'})
    CREATE (rahul:Person {name: 'Rahul', email: 'rahul@demo.com'})
    CREATE (priya:Person {name: 'Priya', email: 'priya@demo.com'})
    CREATE (aman:Person {name: 'Aman', email: 'aman@demo.com'})

    CREATE (neha)-[:REPORTS_TO]->(karan)
    CREATE (rahul)-[:REPORTS_TO]->(neha)
    CREATE (priya)-[:REPORTS_TO]->(neha)
    CREATE (aman)-[:REPORTS_TO]->(neha)
    """
    graph.query(cypher_people)

    # 4. Create Projects and WORKED_ON relationships
    # Website Launch: Rahul, Priya, Aman, Neha
    # Mobile App: Priya, Aman
    cypher_projects = """
    CREATE (w:Project {name: 'Website Launch'})
    CREATE (m:Project {name: 'Mobile App'})

    WITH w, m
    MATCH (rahul:Person {name: 'Rahul'}), (priya:Person {name: 'Priya'}),
          (aman:Person {name: 'Aman'}), (neha:Person {name: 'Neha'})

    CREATE (rahul)-[:WORKED_ON]->(w)
    CREATE (priya)-[:WORKED_ON]->(w)
    CREATE (aman)-[:WORKED_ON]->(w)
    CREATE (neha)-[:WORKED_ON]->(w)

    CREATE (priya)-[:WORKED_ON]->(m)
    CREATE (aman)-[:WORKED_ON]->(m)
    """
    graph.query(cypher_projects)

    # 5. Create Tasks with ownership and project membership
    tasks_data = [
        {"id": 1, "name": "Complete project documentation", "owner": "Rahul", "project": "Website Launch", "deadline": offset(-1), "status": "Pending"},
        {"id": 2, "name": "Finish frontend", "owner": "Priya", "project": "Website Launch", "deadline": offset(1), "status": "In progress"},
        {"id": 3, "name": "Test backend", "owner": "Aman", "project": "Website Launch", "deadline": offset(-2), "status": "Pending"},
        {"id": 4, "name": "Prepare demo video", "owner": "Priya", "project": "Website Launch", "deadline": offset(-3), "status": "Done"},
        {"id": 5, "name": "Write README", "owner": "Rahul", "project": "Website Launch", "deadline": offset(3), "status": "Pending"},
        {"id": 6, "name": "Deploy to production", "owner": "Aman", "project": "Website Launch", "deadline": offset(4), "status": "Pending"},
        {"id": 7, "name": "Design app onboarding", "owner": "Priya", "project": "Mobile App", "deadline": offset(-1), "status": "Pending"},
        {"id": 8, "name": "Build push notifications", "owner": "Aman", "project": "Mobile App", "deadline": offset(2), "status": "Pending"},
    ]

    for t in tasks_data:
        cypher_task = """
        MATCH (p:Person {name: $owner})
        MATCH (pr:Project {name: $project})
        CREATE (task:Task {
            id: $id,
            name: $name,
            deadline: $deadline,
            status: $status,
            reminderSent: false,
            reminderSentAt: null
        })
        CREATE (p)-[:OWNS]->(task)
        CREATE (task)-[:IN_PROJECT]->(pr)
        """
        graph.query(cypher_task, {
            "owner": t["owner"],
            "project": t["project"],
            "id": t["id"],
            "name": t["name"],
            "deadline": t["deadline"],
            "status": t["status"]
        })

    # 6. Create DEPENDS_ON relationships (A depends on B / A is blocked by B)
    # 2->3, 6->2, 6->3, 5->1, 8->7
    dependencies = [
        (2, 3),
        (6, 2),
        (6, 3),
        (5, 1),
        (8, 7),
    ]
    for dep_from, dep_to in dependencies:
        cypher_dep = """
        MATCH (a:Task {id: $from_id}), (b:Task {id: $to_id})
        CREATE (a)-[:DEPENDS_ON]->(b)
        """
        graph.query(cypher_dep, {"from_id": dep_from, "to_id": dep_to})

    # 7. Verify counts
    res_tasks = graph.query("MATCH (t:Task) RETURN count(t)")[0][0]
    res_people = graph.query("MATCH (p:Person) RETURN count(p)")[0][0]
    res_projects = graph.query("MATCH (pr:Project) RETURN count(pr)")[0][0]
    res_deps = graph.query("MATCH ()-[r:DEPENDS_ON]->() RETURN count(r)")[0][0]

    return {
        "status": "seeded",
        "today": today_str,
        "counts": {
            "tasks": res_tasks,
            "people": res_people,
            "projects": res_projects,
            "dependsOn": res_deps,
        }
    }


if __name__ == "__main__":
    result = reset_and_seed()
    print("Seeding completed successfully:", result)
