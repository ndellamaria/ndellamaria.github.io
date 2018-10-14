def findRegion(g1, g2, c, visited, res):
    result = res
    
    print("checking: {}".format(c))

    # if c in visited:
    #     print("in visited")
    #     return False
    
    visited.append(c)
    
    x = c[0]
    y = c[1]
    
    if g1[x][y] is not g2[x][y]:
        print("g1 is not g2")
        print(g1[x][y])
        print(g2[x][y])
        return False
    
    if g1[x][y] == g2[x][y] and g1[x][y] == "0":
        return result
    
    if g1[x][y] == g2[x][y] and g1[x][y] == "1":
        
        # go right
        if x < len(g1)-1:
            newCoor = (x+1, y)
            result = findRegion(g1, g2, newCoor, visited, result)
                     
        # go down 
        if y < len(g1[0])-1:
            newCoor = (x, y+1)
            result = findRegion(g1, g2, newCoor, visited, result)
            
        # go up
        print("here {} {} going up".format(x, y))
        if y > 0:
            newCoor = (x, y-1)
            result = findRegion(g1, g2, newCoor, visited, result)
             
        # go left
        if x > 0:
            newCoor = (x-1, y)
            result = findRegion(g1, g2, newCoor, visited, result)
            
    if result == True:
        print("success")
    return result
    
        

    

def countMatches(grid1, grid2):
    # Write your code here
    visited = []
    total = 0
    for i in range(0, len(grid1)):
        for j in range(0, len(grid1[i])):
            newCoor = (i, j)   
            if newCoor not in visited and grid1[i][j] == "1" and grid2[i][j] == "1":
                if findRegion(grid1, grid2, newCoor, visited, True) == True:
                    total +=1 
    return total
                